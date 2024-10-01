import { HistoryStore, QueueService, ExecutionId } from "./backend";
import { UnorderedEvent } from "./event";
import { OrchestrateResult, orchestrate } from "./orchestrate";
import { Workflow } from "./workflow";
import { v4 as uuid } from "uuid";

export class WorkflowRuntime implements WorkflowRuntime {
  constructor(
    protected readonly historyStore: HistoryStore,
    protected readonly queueService: QueueService,
  ) {}

  async start<In extends any[], Out>(
    workflow: Workflow<string, In, Out>,
    input: In,
  ): Promise<ExecutionId> {
    const executionId = uuid();

    await this.historyStore.save(executionId, {
      input,
      events: [],
      output: undefined,
    });

    await this.continue(
      workflow as Workflow<string, any[], Out>,
      executionId,
      [],
    );

    return executionId;
  }

  async continue<In extends any[], Out>(
    workflow: Workflow<string, In, Out>,
    executionId: ExecutionId,
    events: UnorderedEvent[],
  ): Promise<OrchestrateResult<Awaited<Out>>> {
    const execution = await this.historyStore.get<In, Out>(executionId);

    const result = await orchestrate(workflow, execution, events);

    await this.historyStore.save(executionId, {
      ...execution,
      events: [...execution.events, ...result.history],
    });

    // scheduled all the latest requests (this must be idempotent with at-least-once semantics, so duplicate task requests and responses are expected to be received by both the orchestrator and task executor)
    await this.queueService.emit(executionId, result.events);

    // save the history to a strongly consistent store (e.g. s3 or a file system)
    await this.historyStore.save(executionId, {
      input: execution.input,
      events: result.history,
      output: result.output,
    });

    return result;
  }
}
