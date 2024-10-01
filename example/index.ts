import type {
  SQSEvent,
  Context,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { workflow } from "../src/workflow.js";
import { AWSRuntime, InvokeLambdaRequest } from "../src/aws.js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

const fifoQueueUrl = env("QUEUE_URL");
const fifoQueueArn = env("QUEUE_ARN");
const bucketName = env("BUCKET_NAME");
const timerQueueUrl = process.env.TIMER_QUEUE_URL;
const roleArn = process.env.ROLE_ARN;
const workerFunctionName = process.env.WORKER_FUNCTION_NAME;

const s3Client = new S3Client({});

const runtime = new AWSRuntime({
  fifoQueueUrl,
  fifoQueueArn,
  timerQueueUrl,
  bucketName,
  roleArn,
  objectPrefix: process.env.OBJECT_PREFIX ?? "executions/",
  workerFunctionName,
  s3Client,
});

// Lambda Function entrypoint that starts workflow executions in response to an API request (function URL)
export const api = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const executionId = await runtime.startExecution(uploadObjectWorkflow, [
    "key",
    "data",
  ]);
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      executionId,
    }),
  };
};

// Lambda Function entrypoint that performs workflow orchestration (attached to a SQS FIFO Queue)
export async function orchestrate(event: SQSEvent, context: Context) {
  return runtime.orchestrate(event, context);
}

// Lambda Function entrypoint that performs task executions (received as Lambda EVENT (async) invocations)
export async function execute(event: InvokeLambdaRequest, context: Context) {
  return runtime.execute(event, context);
}

// a workflow is implemented as a simple function accepting context and arbitrary parameters
export const uploadObjectWorkflow = workflow(
  "uploadObjectWorkflow",
  async (ctx, key: string, data: string) => {
    // ctx.sleep will sleep (pause the workflow) for 1 second
    await ctx.sleep(1);

    // ctx.task will asynchronously (and durably, with at-least-once delivery) run the provided function in the worker Lambda Function
    await ctx.task(async () => {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: data,
        }),
      );
    });

    const response = await ctx.task(async () => {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        }),
      );

      return response.Body?.transformToString() ?? "";
    });

    return response;
  },
);
