import fs from "fs/promises";
import path from "path";
import { QueueService, HistoryStore, ExecutionHistory } from "../backend.js";
import {
  RequestEvent,
  TaskResponse,
  Unordered,
  UnorderedEvent,
} from "../event.js";
import { WorkflowRuntime } from "../runtime.js";
import { Workflow } from "../workflow.js";

export class LocalWorkflowRuntime extends WorkflowRuntime {
  protected readonly queueService: LocalQueueService;

  constructor(stateDir: string) {
    const queueService = new LocalQueueService();
    super(new LocalHistoryStore(stateDir), queueService);
    this.queueService = queueService;
  }

  /**
   * Executes a workflow from start to finish (eagerly).
   *
   * This is only useful when running in local mode (e.g. for testing)
   *
   * Other backends (like AWS or CloudFlare) will be event-driven (e.g. SQS FIFO -> Lambda, or Durable Objects)
   */
  async execute<In extends any[], Out>(
    workflow: Workflow<string, In, Out>,
    input: In,
  ): Promise<Out> {
    const executionId = await this.start(workflow, input);

    while (true) {
      const events = await this.queueService.poll(executionId);

      const result = await this.continue(workflow, executionId, events);

      if (result.output) {
        if (result.output.value) {
          return result.output.value;
        } else {
          throw new Error(result.output.error);
        }
      }

      await new Promise((resolve) => {
        // 10ms ticks to avoid busy-waiting
        setTimeout(resolve, 10);
      });
    }
  }
}

export class LocalQueueService implements QueueService {
  private readonly eventFifoQueue: Map<string, UnorderedEvent[]> = new Map();

  async poll(executionId: string): Promise<UnorderedEvent[]> {
    const events = this.eventFifoQueue.get(executionId) ?? [];
    this.eventFifoQueue.delete(executionId);
    return events;
  }

  async emit(executionId: string, events: RequestEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === "sleep") {
        await new Promise((resolve) => {
          setTimeout(
            () =>
              this._emit(executionId, {
                kind: "response",
                type: "sleep",
                replyTo: event.seq,
              }),
            event.duration,
          );
          // resolve this promise immediately (the API is async and the timer will be resolved later when polling the event FIFO queue)
          resolve(undefined);
        });
      } else {
        await new Promise((resolve, reject) => {
          resolve(undefined);

          try {
            event
              .func()
              .then((result) => {
                this._emit(executionId, {
                  kind: "response",
                  type: "task",
                  replyTo: event.seq,
                  result,
                } satisfies Unordered<TaskResponse>);
              })
              .catch(reject);
          } catch (error) {
            reject(error);
          }
        });
      }
    }
  }

  private _emit(executionId: string, event: UnorderedEvent) {
    const q = this.eventFifoQueue.get(executionId) ?? [];
    q.push(event);
    this.eventFifoQueue.set(executionId, q);
  }
}

export class LocalHistoryStore implements HistoryStore {
  constructor(private readonly stateDir: string) {}

  async get<In extends any[], Out>(
    executionId: string,
  ): Promise<ExecutionHistory<In, Out>> {
    const file = getExecutionFilePath(this.stateDir, executionId);
    if (!(await fs.stat(file)).isFile()) {
      throw new Error(`Execution history not found: ${file}`);
    }
    return JSON.parse(await fs.readFile(file, "utf-8"));
  }

  async save(
    executionId: string,
    history: ExecutionHistory<any[], any>,
  ): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(
      getExecutionFilePath(this.stateDir, executionId),
      JSON.stringify(history, null, 2),
    );
  }
}

function getExecutionFilePath(stateDir: string, executionId: string): string {
  return path.join(stateDir, `${executionId}.json`);
}
