import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  SchedulerClient,
  CreateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  RequestEvent,
  ResponseEvent,
  SleepResponse,
  Unordered,
  UnorderedEvent,
} from "./event.js";
import { v4 as uuid } from "uuid";
import type { SQSEvent, Context } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  ExecutionHistory,
  ExecutionId,
  Runtime,
  TaskEnvelope,
} from "./runtime.js";
import { getWorkflowFromExecutionId } from "./workflow.js";

export interface InvokeLambdaRequest {
  executionId: string;
  task: TaskEnvelope;
}

export class AWSRuntime extends Runtime {
  private readonly bucketName: string;
  private readonly objectPrefix: string;
  private readonly roleArn?: string;
  private readonly fifoQueueUrl?: string;
  private readonly fifoQueueArn?: string;
  private readonly timerQueueUrl?: string;
  private readonly workerFunctionName?: string;

  private readonly sqsClient: SQSClient;
  private readonly s3Client: S3Client;
  private readonly schedulerClient: SchedulerClient;
  private readonly lambdaClient: LambdaClient;
  constructor(props: {
    bucketName: string;
    objectPrefix: string;
    roleArn?: string;
    fifoQueueUrl?: string;
    fifoQueueArn?: string;
    timerQueueUrl?: string;
    workerFunctionName?: string;
    sqsClient?: SQSClient;
    s3Client?: S3Client;
    schedulerClient?: SchedulerClient;
    lambdaClient?: LambdaClient;
  }) {
    super();
    this.bucketName = props.bucketName;
    this.objectPrefix = props.objectPrefix;
    this.roleArn = props.roleArn;
    this.fifoQueueUrl = props.fifoQueueUrl;
    this.fifoQueueArn = props.fifoQueueArn;
    this.timerQueueUrl = props.timerQueueUrl;
    this.workerFunctionName = props.workerFunctionName;
    this.sqsClient = props.sqsClient ?? new SQSClient({});
    this.s3Client = props.s3Client ?? new S3Client({});
    this.schedulerClient = props.schedulerClient ?? new SchedulerClient({});
    this.lambdaClient = props.lambdaClient ?? new LambdaClient({});
  }

  /**
   * Handles Lambda Invocation events (that are expected to either be from SQS, the EventBridge Scheduler, or sent directly from a Lambda Worker)
   */
  public async orchestrate(event: SQSEvent, context: Context): Promise<void> {
    console.log("orchestrate", event);
    // for now, am assuming that each invocation contains events only for a single message group
    // https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/fifo-queue-lambda-behavior.html

    const firstRecord = event.Records[0];
    const executionId = firstRecord.attributes.MessageGroupId;
    if (!executionId) {
      throw new Error("Missing MessageGroupId in SQS record");
    }
    if (!executionId.includes(":")) {
      throw new Error(`Invalid executionId: ${executionId}`);
    }

    const workflow = getWorkflowFromExecutionId(executionId);

    await this.continueExecution(
      workflow,
      executionId,
      event.Records.map((r) => JSON.parse(r.body) as UnorderedEvent),
    );
  }

  public async execute(event: InvokeLambdaRequest, context: Context) {
    console.log("execute", JSON.stringify(event, null, 2));
    const workflow = getWorkflowFromExecutionId(event.executionId);

    await this.executeTask(workflow, event.executionId, event.task);
  }

  async sendEvent(
    executionId: string,
    event: Unordered<ResponseEvent>,
  ): Promise<void> {
    const command = new SendMessageCommand({
      QueueUrl: this.fifoQueueUrl,
      MessageBody: JSON.stringify(event),
      MessageGroupId: executionId,
      MessageDeduplicationId: `${executionId}-${event.replyTo}`,
    });

    try {
      await this.sqsClient.send(command);
    } catch (error) {
      console.error("Error sending message to SQS:", error);
      throw error;
    }
  }

  async scheduleTasks(
    executionId: string,
    events: RequestEvent[],
    responseEvents: UnorderedEvent[],
  ): Promise<void> {
    if (this.roleArn === undefined) {
      throw new Error(
        "roleArn must be provided to AWSRuntime when running the orchestrator",
      );
    }
    if (this.workerFunctionName === undefined) {
      throw new Error(
        "workerFunctionName must be provided to AWSRuntime when running the orchestrator",
      );
    }
    if (this.timerQueueUrl === undefined) {
      throw new Error(
        "timerQueueUrl must be provided to AWSRuntime when running the orchestrator",
      );
    }
    await Promise.all(
      events.map(async (event) => {
        if (event.type === "sleep") {
          const now = new Date();
          const scheduledTime = new Date(now.getTime() + event.seconds * 1000);

          // Check if the scheduled time is less than 15 minutes from now
          const fifteenMinutesFromNow = new Date(
            now.getTime() + 15 * 60 * 1000,
          );
          if (scheduledTime.getTime() <= fifteenMinutesFromNow.getTime()) {
            // Calculate the delay in seconds
            const delaySeconds = Math.max(
              0,
              Math.floor((scheduledTime.getTime() - now.getTime()) / 1000),
            );

            // Send a message to the time queue with delayed visibility
            await this.sqsClient.send(
              new SendMessageCommand({
                QueueUrl: this.timerQueueUrl,
                DelaySeconds: delaySeconds,
                MessageBody: JSON.stringify({
                  kind: "response",
                  type: "sleep",
                  replyTo: event.seq,
                } satisfies Unordered<SleepResponse>),
                MessageAttributes: {
                  // inject the executionId into the message so we can use it in an EventBridge Pipe (to set MessageGroupId)
                  executionId: {
                    DataType: "String",
                    StringValue: executionId,
                  },
                  deduplicationId: {
                    DataType: "String",
                    StringValue: `${executionId}-${event.seq}`,
                  },
                },
              }),
            );
          } else {
            const formattedTime = scheduledTime.toISOString().slice(0, 19);

            await this.schedulerClient.send(
              new CreateScheduleCommand({
                Name: uuid(),
                // ActionAfterCompletion: "DELETE",
                // idempotency key that is globally unique to this request
                ClientToken: `${executionId.replace(":", "-")}-${event.seq}`,
                ScheduleExpression: `at(${formattedTime})`,
                ScheduleExpressionTimezone: "UTC",
                FlexibleTimeWindow: {
                  Mode: "OFF",
                },
                Target: {
                  RoleArn: this.roleArn,
                  Arn: this.fifoQueueArn,
                  Input: JSON.stringify({
                    kind: "response",
                    type: "sleep",
                    replyTo: event.seq,
                  } satisfies Unordered<SleepResponse>),
                  SqsParameters: {
                    MessageGroupId: executionId,
                  },
                },
              }),
            );
          }
        } else {
          // For task events, invoke a Lambda function
          await this.lambdaClient.send(
            new InvokeCommand({
              FunctionName: this.workerFunctionName,
              InvocationType: "Event", // Asynchronous invocation
              Payload: JSON.stringify({
                executionId,
                task: {
                  events: responseEvents,
                  request: { kind: "request", type: "task", seq: event.seq },
                },
              } satisfies InvokeLambdaRequest),
            }),
          );
        }
      }),
    );
  }

  async getHistory<In extends any[], Out>(
    executionId: string,
  ): Promise<ExecutionHistory<In, Out>> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: this.getObjectKey(executionId),
    });

    try {
      const response = await this.s3Client.send(command);
      const bodyContents = await response.Body?.transformToString();
      if (!bodyContents) {
        throw new Error("Empty response body");
      }
      return JSON.parse(bodyContents);
    } catch (error) {
      console.error(error);
      throw new Error(`Execution history not found: ${executionId}`);
    }
  }

  async saveHistory(
    executionId: string,
    history: ExecutionHistory<any[], any>,
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: this.getObjectKey(executionId),
      // TODO(sam): use a better format than JSON
      // - e.g. a binary format (e.g. msgpack or arrow)
      Body: JSON.stringify(history, null, 2),
      ContentType: "application/json",
    });

    try {
      await this.s3Client.send(command);
    } catch (error) {
      throw new Error(`Failed to save execution history: ${executionId}`);
    }
  }

  async listExecutions(filters?: {
    workflowName?: string;
  }): Promise<ExecutionId[]> {
    const prefix = filters?.workflowName
      ? `${this.objectPrefix}${filters.workflowName}:`
      : this.objectPrefix;

    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
      MaxKeys: 1000,
    });

    const response = await this.s3Client.send(command);
    return (response.Contents || [])
      .map((obj) => obj.Key)
      .filter((key): key is string => key !== undefined)
      .filter((key) => key.endsWith(".json"))
      .map((key) => key.slice(this.objectPrefix.length, -5)) // Remove prefix and '.json'
      .filter((id) => {
        const parts = id.split(":");
        return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
      });
  }

  private getObjectKey(executionId: string): string {
    return `${this.objectPrefix}${executionId}.json`;
  }
}
