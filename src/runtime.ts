import {
  RequestEvent,
  ResponseEvent,
  Serialized,
  StartWorkflowEvent,
  TaskRequest,
  TaskResponse,
  Unordered,
  UnorderedEvent,
  WorkflowEvent,
  isResponseEvent,
} from "./event.js";
import { OrchestrateResult, orchestrate } from "./orchestrate.js";
import { Result } from "./result.js";
import { Workflow } from "./workflow.js";
import { v4 as uuid } from "uuid";

export type ExecutionId = string;

export interface ExecutionHistory<In extends any[], Out> {
  input: In;
  output?: Result<Out>;
  events: Serialized<WorkflowEvent>[];
}

export interface TaskEnvelope {
  events: UnorderedEvent[];
  request: Serialized<TaskRequest>;
}

export abstract class Runtime {
  /**
   * Get the history of a workflow execution from a strongly consistent store (e.g. s3 or a file system)
   */
  abstract getHistory<In extends any[], Out>(
    executionId: ExecutionId,
  ): Promise<ExecutionHistory<In, Out>>;

  abstract listExecutions(filters?: {
    workflowName?: string;
  }): Promise<ExecutionId[]>;

  /**
   * Save the history of a workflow execution to a strongly consistent store (e.g. s3 or a file system)
   */
  abstract saveHistory(
    executionId: ExecutionId,
    history: ExecutionHistory<any[], any>,
  ): Promise<void>;

  /**
   * Send an event to the orchestrator FIFO queue (e.g. a task response or timer elapsed event).
   */
  abstract sendEvent(
    executionId: ExecutionId,
    event: StartWorkflowEvent | Unordered<ResponseEvent>,
  ): Promise<void>;

  /**
   * Schedule a workflow request (e.g. task or timer)
   */
  abstract scheduleTasks(
    executionId: ExecutionId,
    events: RequestEvent[],
    /**
     * This is a bit of a hack to pass through the events being processed as part of the orchestrate loop through
     * in the {@link TaskEnvelope} so that the (ctx.task(async () => { ... })) closure can be reified in the executor...
     *
     * Without doing this, there is a race between the task executor and the orchestrator. If the orchestrator did not
     * update history before the executor began running (which is possible), then the task executor would have the
     * latest response events (required to invoke the task)
     *
     * TODO(sam): do we really want to do this? We're limited to 256KB of data in the event payload ...
     *
     * Alternative is a DX design question: instead of ctx.task() anywhere in a workflow, tasks would be declared as functions just like workflows:
     * ```ts
     * const myTask = task("task", async (ctx) => {
     *   // ...
     * });
     * ```
     */
    responseEvents: UnorderedEvent[],
  ): Promise<void>;

  /**
   * Start a new workflow execution.
   */
  async startExecution<In extends any[], Out>(
    workflow: Workflow<string, In, Out>,
    input: In,
  ): Promise<ExecutionId> {
    const executionId = `${workflow.name}:${uuid()}`;

    await this.saveHistory(executionId, {
      input,
      events: [],
      output: undefined,
    });

    await this.sendEvent(executionId, {
      kind: "start",
    });

    return executionId;
  }

  /**
   * Continue a workflow execution (by delivering new events and advancing the workflow)
   */
  async continueExecution<In extends any[], Out>(
    workflow: Workflow<string, In, Out>,
    executionId: ExecutionId,
    events: (StartWorkflowEvent | UnorderedEvent)[],
    history?: ExecutionHistory<In, Out>,
  ): Promise<OrchestrateResult<Awaited<Out>>> {
    // filter out the start event, we don't need to consider it (its only purpose is to initiate the workflow)
    const unorderedEvents = events.filter(
      (event): event is UnorderedEvent => event.kind !== "start",
    );

    const execution = history ?? (await this.getHistory<In, Out>(executionId));

    const result = await orchestrate(workflow, execution, unorderedEvents);

    // scheduled all the latest requests (this must be idempotent with at-least-once semantic)
    //  ... duplicate task requests and responses are expected to be received by both the orchestrator and task executor
    await this.scheduleTasks(executionId, result.events, unorderedEvents);

    // save the history to a strongly consistent store (e.g. s3 or a file system)
    await this.saveHistory(executionId, {
      input: execution.input,
      events: result.history,
      output: result.output,
    });

    return result;
  }

  /**
   * Execute a single task within a workflow and send the response back to the orchestrator FIFO queue.
   */
  async executeTask<In extends any[], Out>(
    workflow: Workflow<string, In, Out>,
    executionId: ExecutionId,
    task: TaskEnvelope,
  ): Promise<void> {
    // since tasks are closures (ctx.task(async () => { ... })), we need to reify the task request

    // by first getting the history
    const history = await this.getHistory<In, Out>(executionId);

    const replyMap = new Map(
      history.events
        .filter(isResponseEvent)
        .map((event) => [event.replyTo, event]),
    );

    const taskEvents = task.events.filter(
      (event) => !replyMap.has(event.replyTo),
    );

    console.log("history", JSON.stringify(history, null, 2));

    console.log("events", JSON.stringify(taskEvents, null, 2));

    // and then advancing the workflow to the point where the task is executed
    const orchestrateResult = await orchestrate(workflow, history, taskEvents);

    // we can now find the reified closure on the task request
    const func = orchestrateResult.history.find(
      (event): event is TaskRequest =>
        event.type === "task" &&
        event.kind === "request" &&
        event.seq === task.request.seq,
    )?.func;

    // TODO(sam): this can be quite slow
    // - revisit whether tasks should be required to be static/module declarations
    // - should not be a problem for workflows with a low number of events (e.g. a thousand or so)

    if (!func) {
      console.log("looking for task", task, orchestrateResult.history);
      throw new Error("task not found");
    }

    let error: string | undefined = undefined;
    let value: Awaited<Out> | undefined = undefined;
    try {
      value = await func();
    } catch (error: any) {
      // TODO(sam): is this the best way to serialize errors?
      error = error.toString();
    }

    const response = {
      kind: "response",
      type: "task",
      replyTo: task.request.seq,
      result: {
        error,
        value,
      },
    } as Unordered<TaskResponse>;

    console.log("response", JSON.stringify(response, null, 2));

    await this.sendEvent(executionId, response);
  }
}
