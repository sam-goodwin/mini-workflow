import { expect, test } from "bun:test";

import { workflow } from "../src/workflow.js";
import { WorkflowRuntime } from "../src/runtime.js";
import {
  LocalHistoryStore,
  LocalQueueService,
  LocalWorkflowRuntime,
} from "../src/backends/local.js";

export const testWorkflow = workflow("test", async (ctx, name: string) => {
  console.log("sleeping for 1 second");

  await ctx.sleep(1, "s");

  const value = await ctx.task(async () => {
    return "some expensive value";
  });

  return value;
});

test("run workflow", async () => {
  const stateDir = ".local";
  const runtime = new LocalWorkflowRuntime(stateDir);
  const result = await runtime.execute(testWorkflow, ["sam"]);
  expect(result).toEqual("some expensive value");
});

test("emulate workflow responses", async () => {
  const stateDir = ".local";
  const runtime = new WorkflowRuntime(
    new LocalHistoryStore(stateDir),
    new LocalQueueService(),
  );
  const executionId = await runtime.start(testWorkflow, ["sam"]);

  let execution = await runtime.continue(testWorkflow, executionId, [
    {
      kind: "response",
      type: "sleep",
      replyTo: 0,
    },
  ]);

  // the task should now be scheduled
  expect(execution.events).toMatchObject([
    {
      kind: "request",
      type: "task",
      seq: 2,
    },
  ]);

  // the entire history should be:
  // sleep request -> sleep response -> task request
  expect(execution.history).toMatchObject([
    {
      kind: "request",
      type: "sleep",
      duration: 1000,
      seq: 0,
    },
    {
      kind: "response",
      type: "sleep",
      replyTo: 0,
      seq: 1,
    },
    {
      kind: "request",
      type: "task",
      seq: 2,
    },
  ]);

  // the execution has not completed yet
  expect(execution.output).toBeUndefined();

  // emulate the task completing
  execution = await runtime.continue(testWorkflow, executionId, [
    {
      kind: "response",
      type: "task",
      replyTo: 2,
      result: "some expensive value",
    },
  ]);

  // now, the execution should be complete
  expect(execution.output).toEqual({
    value: "some expensive value",
  });
});
