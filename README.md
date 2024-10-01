# mini-workflow (name subject to change)

This is a mini Temporal-like workflow engine for TypeScript implemented with pluggable backends for AWS (CloudFlare coming soon).

> [!CAUTION]
> The code was build in a day and is not fully tested. The e2e example works, but there may be bugs.

# Why

It was built in response to Dax's relentless begging for a simple workflow engine that can run on AWS:

> please someone build a workflow engine as a library that can be backed by various stores
>
> i am telling you this will become one of the most used packages ever - it eliminates the need for so much
>
> - https://x.com/thdxr/status/1840858283168710884

Also, because durable workflow orchestration is a powerful primitive for event-driven systems and can be trivially implemented with AWS Lambda, S3, SQS and Event Bridge.

# Example

- See the [example/index.ts](./example/index.ts) file for the runtime code (code that runs in AWS).
- See the [sst.config.ts](./sst.config.ts) file for infrastructure configuration.

# Usage

## SST Config

```ts
const engine = new WorkflowEngine("WorkflowEngine", {
  worker: "example/index.execute",
  orchestrator: "example/index.orchestrate",
});
```

## App Code

```ts
import { workflow } from "mini-workflow";

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
        })
      );
    });

    const response = await ctx.task(async () => {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        })
      );

      return response.Body?.transformToString() ?? "";
    });

    return response;
  }
);
```
