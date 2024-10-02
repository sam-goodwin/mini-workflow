import { ResponseEvent, TaskResponse } from "./event.js";
import { Runtime } from "./runtime.js";
import { ExecutionContext, getWorkflowFromExecutionId } from "./workflow.js";
import path from "path";

export async function replay({
  main,
  runtime,
  executionId,
}: {
  main: string;
  runtime: Runtime;
  executionId: string;
}) {
  await import(path.resolve(main));

  const workflow = getWorkflowFromExecutionId(executionId);

  // load the history from S3
  const history = await runtime.getHistory(executionId);

  const requestSeqs = new Set<number>(
    history.events.filter((e) => e.kind === "request").map((e) => e.seq),
  );

  let seq = 0;

  function nextSeq() {
    seq += 1;
    while (requestSeqs.has(seq)) {
      seq += 1;
    }
    return seq;
  }

  const hooks: {
    [seq: number]: ResponseEvent | ((response: ResponseEvent) => any);
  } = {};

  const ctx: ExecutionContext = {
    task: async <Out>(func: () => Promise<Out>): Promise<Out> => {
      return new Promise<Out>((resolve, reject) => {
        const seq = nextSeq();

        if (seq in hooks) {
          const event = hooks[seq] as TaskResponse;
          if (event.result.error) {
            reject(event.result.error);
          } else {
            resolve(event.result.value);
          }
        } else {
          hooks[seq] = (response: ResponseEvent) => {
            if (response.type === "task") {
              if (response.result.error) {
                reject(response.result.error);
              } else {
                resolve(response.result.value);
              }
            }
          };
        }
      });
    },
    sleep: async (ms: number) => {
      return new Promise((resolve) => {
        const seq = nextSeq();
        if (seq in hooks) {
          resolve();
        } else {
          hooks[seq] = () => resolve();
        }
      });
    },
  };

  await Promise.all([
    workflow.handler(ctx, ...history.input),
    (async function () {
      for (const event of history.events) {
        if (event.kind === "response") {
          if (event.seq in hooks) {
            (hooks[event.seq] as (response: ResponseEvent) => any)(event);
          } else {
            hooks[event.seq] = event;
          }
        }
      }
    })(),
  ]);
}
