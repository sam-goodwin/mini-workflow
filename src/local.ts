import fs from "fs/promises";
import path from "path";
import {
  RequestEvent,
  ResponseEvent,
  Unordered,
  UnorderedEvent,
} from "./event.js";
import { ExecutionHistory, Runtime } from "./runtime.js";
import { Workflow, getWorkflowFromExecutionId } from "./workflow.js";

export class LocalRuntime extends Runtime {
  private readonly eventFifoQueue: Map<string, UnorderedEvent[]> = new Map();

  constructor(private readonly stateDir: string) {
    super();
  }

  /**
   * Executes a workflow from start to finish (eagerly).
   *
   * This is only useful when running in local mode (e.g. for testing)
   *
   * Other backends (like AWS or CloudFlare) will be event-driven (e.g. SQS FIFO -> Lambda, or Durable Objects)
   */
  async runLocallyToFinish<In extends any[], Out>(
    workflow: Workflow<string, In, Out>,
    input: In,
  ): Promise<Out> {
    const executionId = await this.startExecution(workflow, input);

    while (true) {
      const events = this.eventFifoQueue.get(executionId) ?? [];
      this.eventFifoQueue.delete(executionId);

      if (events.length > 0) {
        const result = await this.continueExecution(
          workflow,
          executionId,
          events,
        );

        if (result.output) {
          if (result.output.value) {
            return result.output.value;
          } else {
            throw result.output.error;
          }
        }
      }

      await new Promise((resolve) => {
        // 10ms ticks to avoid busy-waiting
        setTimeout(resolve, 10);
      });
    }
  }

  async sendEvent(
    executionId: string,
    event: Unordered<ResponseEvent>,
  ): Promise<void> {
    const q = this.eventFifoQueue.get(executionId) ?? [];
    q.push(event);
    this.eventFifoQueue.set(executionId, q);
  }

  async scheduleTasks(
    executionId: string,
    requestEvents: RequestEvent[],
    responseEvents: Unordered<ResponseEvent>[],
  ): Promise<void> {
    for (const event of requestEvents) {
      if (event.type === "sleep") {
        setTimeout(
          () =>
            this.sendEvent(executionId, {
              kind: "response",
              type: "sleep",
              replyTo: event.seq,
            }),
          event.seconds * 1000,
        );
      } else {
        this.executeTask(getWorkflowFromExecutionId(executionId), executionId, {
          events: responseEvents,
          request: event,
        });
      }
    }
  }
  async getHistory<In extends any[], Out>(
    executionId: string,
  ): Promise<ExecutionHistory<In, Out>> {
    const file = this.getExecutionFilePath(executionId);
    if (!(await fs.stat(file)).isFile()) {
      throw new Error(`Execution history not found: ${file}`);
    }
    return JSON.parse(await fs.readFile(file, "utf-8"));
  }

  async saveHistory(
    executionId: string,
    history: ExecutionHistory<any[], any>,
  ): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(
      this.getExecutionFilePath(executionId),
      JSON.stringify(history, null, 2),
    );
  }

  private getExecutionFilePath(executionId: string): string {
    return path.join(this.stateDir, `${executionId}.json`);
  }
}
