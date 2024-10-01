import { Workflow } from "./workflow.js";
import type {
  RequestEvent,
  Serialized,
  UnorderedEvent,
  WorkflowEvent,
} from "./event.js";
import { Result } from "./result.js";
import type { OrchestrateResult } from "./orchestrate.js";

export interface ExecutionHistory<In extends any[], Out> {
  input: In;
  output?: Result<Out>;
  events: Serialized<WorkflowEvent>[];
}

export interface HistoryStore {
  get<In extends any[], Out>(
    executionId: string,
  ): Promise<ExecutionHistory<In, Out>>;

  save(
    executionId: string,
    history: ExecutionHistory<any[], any>,
  ): Promise<void>;
}

export interface QueueService {
  emit(executionId: string, events: RequestEvent[]): Promise<void>;
}

export type ExecutionId = string;
