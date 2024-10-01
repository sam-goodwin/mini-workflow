/// <reference path="./.sst/platform/config.d.ts" />

import { WorkflowEngine } from "./src/sst";

export default $config({
  app(input) {
    return {
      name: "mini-workflow-example",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: {
          profile: process.env.AWS_PROFILE,
          region: "us-west-2",
          version: "6.52.0",
        },
      },
    };
  },
  async run() {
    const engine = new WorkflowEngine("WorkflowEngine", {
      worker: "example/index.execute",
      orchestrator: "example/index.orchestrate",
    });

    // this lambda function is an API that can be used to trigger workflows
    const api = new sst.aws.Function("Api", {
      handler: "example/index.api",
      url: true,
      link: [engine.history, engine.events],
      environment: {
        QUEUE_URL: engine.events.url,
        QUEUE_ARN: engine.events.arn,
        WORKER_FUNCTION_NAME: engine.worker.name,
        TIMER_QUEUE_URL: engine.timers.url,
      },
    });

    return {
      url: api.url,
    };
  },
});
