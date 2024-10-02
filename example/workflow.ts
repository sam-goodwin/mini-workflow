import { workflow } from "../src/workflow.js";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const bucketName = process.env.BUCKET_NAME!;

const s3Client = new S3Client({});

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
