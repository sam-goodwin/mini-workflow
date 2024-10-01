// @ts-nocheck
// TODO(sam): what is the right way to build an SST component?

import aws from "@pulumi/aws";
import pulumi from "@pulumi/pulumi";

export class WorkflowEngine extends pulumi.ComponentResource {
  public readonly history: sst.aws.Bucket;
  public readonly events: sst.aws.Queue;
  public readonly timers: sst.aws.Queue;
  public readonly worker: sst.aws.Function;
  public readonly orchestrator: sst.aws.QueueSubscriber;

  constructor(
    name: string,
    args: {
      worker: string;
      orchestrator: string;
    },
    _opts?: pulumi.ComponentResourceOptions,
  ) {
    super("mini:Workflow", name, undefined, _opts);

    const opts: pulumi.ComponentResourceOptions = {
      parent: this,
    };

    // history events for each workflow execution are stored in s3, s3://bucket/executions/{executionId}.json
    this.history = new sst.aws.Bucket("History", undefined, opts);

    // FIFO for deterministic execution
    this.events = new sst.aws.Queue(
      "Events",
      {
        fifo: true,
      },
      opts,
    );

    // for 1-second precision timers, we use the a Standard SQS Queue with Delayed Message Visibility
    this.timers = new sst.aws.Queue("Timers", undefined, opts);

    const timerPipeRole = new aws.iam.Role(
      "TimerPipeRole",
      {
        assumeRolePolicy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["sts:AssumeRole"],
              Principal: {
                Service: ["pipes.amazonaws.com"],
              },
            },
          ],
        },
      },
      opts,
    );

    // Grant necessary permissions to the pipe
    const timerPipePolicy = new aws.iam.RolePolicy(
      "TimerPipePolicy",
      {
        role: timerPipeRole.name,
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
              ],
              Resource: this.timers.arn,
            },
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage*"],
              Resource: this.events.arn,
            },
          ],
        }),
      },
      opts,
    );

    // Create an EventBridge Pipe to forward events from timers to events
    new aws.pipes.Pipe(
      "TimerPipe",
      {
        source: this.timers.arn,
        target: this.events.arn,
        roleArn: timerPipeRole.arn,
        sourceParameters: {
          sqsQueueParameters: {
            batchSize: 1,
            maximumBatchingWindowInSeconds: 0,
          },
        },
        targetParameters: {
          sqsQueueParameters: {
            // see: https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-event-target.html#pipes-targets-dynamic-parms
            messageGroupId: "$.messageAttributes.executionId.stringValue",
            messageDeduplicationId:
              "$.messageAttributes.deduplicationId.stringValue",
          },
          // holy fuck event bridge was built by brain dead people, we need to use a static input template to get a simple passthrough ...
          inputTemplate:
            '{"kind": "<$.body.kind>", "type": "<$.body.type>", "replyTo": <$.body.replyTo>}',
        },
      },
      {
        parent: this,
        dependsOn: [timerPipePolicy],
      },
    );

    // TODO(sam): use `link: [ .. ]` exclusively?
    const env = {
      QUEUE_URL: this.events.url,
      QUEUE_ARN: this.events.arn,
      BUCKET_NAME: this.history.name,
    };

    const workerRole = new aws.iam.Role(
      "WorkerRole",
      {
        assumeRolePolicy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["sts:AssumeRole"],
              Principal: {
                Service: ["lambda.amazonaws.com", "scheduler.amazonaws.com"],
              },
            },
          ],
        },
      },
      opts,
    );

    new aws.iam.RolePolicy(
      "WorkerPolicies",
      {
        role: workerRole.name,
        policy: pulumi.jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject"],
              Resource: [
                this.history.arn,
                pulumi.interpolate`${this.history.arn}/*`,
              ],
            },
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage*"],
              Resource: [this.events.arn],
            },
          ],
        }),
      },
      opts,
    );

    new aws.iam.RolePolicyAttachment(
      "WorkerCloudWatchPolicy",
      {
        policyArn:
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        role: workerRole.name,
      },
      opts,
    );

    // this lambda function executes tasks (does the work)
    this.worker = new sst.aws.Function(
      "Worker",
      {
        handler: args.worker,
        environment: env,
        timeout: "10 minutes",
        link: [this.events, this.history],
        role: workerRole.arn,
      },
      opts,
    );

    // this lambda function orchestrates workflows (makes the decisions)
    this.orchestrator = this.events.subscribe({
      handler: args.orchestrator,
      environment: {
        ...env,
        ROLE_ARN: workerRole.arn,
        WORKER_FUNCTION_NAME: this.worker.name,
        TIMER_QUEUE_URL: this.timers.url,
      },
      timeout: "30 seconds",
      link: [this.events, this.history, this.timers, this.worker],
    }); // TODO(sst devs): allow opts to be passed in to subscribe

    new aws.iam.PolicyAttachment(
      "SchedulerPolicyAttachment",
      {
        policyArn:
          "arn:aws:iam::aws:policy/AmazonEventBridgeSchedulerFullAccess",
        // @ts-expect-error
        roles: [this.orchestrator.function.role],
      },
      opts,
    );
  }
}
