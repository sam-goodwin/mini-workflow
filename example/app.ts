import type { SQSEvent, Context } from "aws-lambda";
import { workflow } from "../src/workflow.js";
import { AWSRuntime, InvokeLambdaRequest } from "../src/aws.js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const fifoQueueUrl = process.env.QUEUE_URL!;
const fifoQueueArn = process.env.QUEUE_ARN!;
const bucketName = process.env.BUCKET_NAME!;
const roleArn = process.env.ROLE_ARN!;
const workerFunctionName = process.env.WORKER_FUNCTION_NAME!;

const s3Client = new S3Client({});

export const uploadObjectWorkflow = workflow(
  "uploadObjectWorkflow",
  async (ctx, key: string, data: string) => {
    console.log("beginning uploadObjectWorkflow");
    await ctx.sleep(1);

    console.log("scheduling put object");
    await ctx.task(async () => {
      console.log("doing put object");
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: data,
        }),
      );
    });

    console.log("scheduling get object");
    const response = await ctx.task(async () => {
      console.log("doing get object");
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        }),
      );

      return response.Body?.transformToString() ?? "";
    });

    console.log("done uploadObjectWorkflow: ", response);
    return response;
  },
);

const runtime = new AWSRuntime({
  fifoQueueUrl,
  fifoQueueArn,
  bucketName,
  roleArn,
  objectPrefix: "executions/",
  workerFunctionName,
});

export async function handle(
  event: SQSEvent | InvokeLambdaRequest,
  context: Context,
) {
  return runtime.handle(event, context);
}
