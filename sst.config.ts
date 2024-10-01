/// <reference path="./.sst/platform/config.d.ts" />

import aws from "@pulumi/aws";
import pulumi from "@pulumi/pulumi";

export default $config({
  app(input) {
    return {
      name: "aspect-example",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: {
          profile: "aspect-us-east-1",
          region: "us-west-2",
          version: "6.52.0",
        },
      },
    };
  },
  async run() {
    // history events for each workflow execution are stored in s3, s3://bucket/executions/{executionId}.json
    const history = new sst.aws.Bucket("History");

    // FIFO for deterministic execution
    const events = new sst.aws.Queue("Events", {
      fifo: true,
    });

    // for 1-second precision timers, we use the a Standard SQS Queue with Delayed Message Visibility
    const timers = new sst.aws.Queue("Timers");

    const timerPipeRole = new aws.iam.Role("TimerPipeRole", {
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
    });

    // Grant necessary permissions to the pipe
    const timerPipePolicy = new aws.iam.RolePolicy("TimerPipePolicy", {
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
            Resource: timers.arn,
          },
          {
            Effect: "Allow",
            Action: ["sqs:SendMessage*"],
            Resource: events.arn,
          },
        ],
      }),
    });

    // Create an EventBridge Pipe to forward events from timers to events
    new aws.pipes.Pipe(
      "TimerPipe",
      {
        source: timers.arn,
        target: events.arn,
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
        dependsOn: [timerPipePolicy],
      },
    );

    // TODO(sam): use `link: [ .. ]` exclusively?
    const env = {
      QUEUE_URL: events.url,
      QUEUE_ARN: events.arn,
      BUCKET_NAME: history.name,
    };

    const workerRole = new aws.iam.Role("WorkerRole", {
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
    });

    new aws.iam.RolePolicy("WorkerPolicies", {
      role: workerRole.name,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: [history.arn, pulumi.interpolate`${history.arn}/*`],
          },
          {
            Effect: "Allow",
            Action: ["sqs:SendMessage*"],
            Resource: [events.arn],
          },
        ],
      }),
    });

    new aws.iam.RolePolicyAttachment("WorkerCloudWatchPolicy", {
      policyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      role: workerRole.name,
    });

    // this lambda function executes tasks (does the work)
    const worker = new sst.aws.Function("Worker", {
      handler: "example/index.execute",
      environment: env,
      timeout: "10 minutes",
      link: [events, history],
      role: workerRole.arn,
    });

    // this lambda function orchestrates workflows (makes the decisions)
    const orchestrator = events.subscribe({
      handler: "example/index.orchestrate",
      environment: {
        ...env,
        ROLE_ARN: workerRole.arn,
        WORKER_FUNCTION_NAME: worker.name,
        TIMER_QUEUE_URL: timers.url,
      },
      timeout: "30 seconds",
      link: [events, history, timers, worker],
    });

    // this lambda function is an API that can be used to trigger workflows
    const api = new sst.aws.Function("Api", {
      handler: "example/index.api",
      url: true,
      link: [history, events],
      environment: env,
    });

    new aws.iam.PolicyAttachment("SchedulerPolicyAttachment", {
      policyArn: "arn:aws:iam::aws:policy/AmazonEventBridgeSchedulerFullAccess",
      // @ts-expect-error - SST should expose this (or i should create my own role)
      roles: [orchestrator.function.role],
    });

    return {
      url: api.url,
    };
  },
});
