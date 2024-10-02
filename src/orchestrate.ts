import {
  WorkflowEvent,
  isRequestEvent,
  RequestEvent,
  isEventEqual,
  UnorderedEvent,
  isResponseEvent,
} from "./event";
import { Result } from "./result";
import { ExecutionHistory } from "./runtime";
import { Workflow, ExecutionContext } from "./workflow";

export interface OrchestrateResult<Out> {
  /**
   * The Result (error or success) if the workflow has terminated
   */
  output: Result<Out> | undefined;
  /**
   * Request Events that need to be emitted
   */
  events: RequestEvent[];
  /**
   * The updated history of the workflow
   */
  history: WorkflowEvent[];
}

export async function orchestrate<Name extends string, In extends any[], Out>(
  workflow: Workflow<Name, In, Out>,
  history: ExecutionHistory<In, Out>,
  events: UnorderedEvent[],
): Promise<OrchestrateResult<Awaited<Out>>> {
  // copy the history events to a mutable array (we want to be a good citizen)
  const historyEvents = [...history.events];

  {
    // merge the new unordered events with the existing history (taking care to filter out duplicates)
    let historySeq = history.events
      .map((e) => e.seq)
      .reduce((acc, seq) => Math.max(acc, seq), 0);

    const historyMap = new Map(historyEvents.map((e) => [e.seq, e]));
    const responseHistoryMap = new Map(
      historyEvents.flatMap((e) =>
        isResponseEvent(e) ? [[e.replyTo, e]] : [],
      ),
    );
    for (const responseEvent of events) {
      if (!responseHistoryMap.has(responseEvent.replyTo)) {
        const event = {
          ...responseEvent,
          seq: (historySeq += 1),
        };
        responseHistoryMap.set(responseEvent.replyTo, event);
        historyEvents.push(event);
        historyMap.set(event.seq, event);
      } else {
        console.log(`duplicate: ${JSON.stringify(responseEvent, null, 2)}`);
      }
    }
  }

  const requestHistory = new Map(
    historyEvents.flatMap((e) => (isRequestEvent(e) ? [[e.seq, e]] : [])),
  );
  const replayedEvents: WorkflowEvent[] = [];
  const emitEvents: RequestEvent[] = [];

  type Callback = (result: any) => void;
  const requestCallbacks = new Map<number, [Callback, Callback]>();

  function appendRequestEvent(event: RequestEvent) {
    // console.log(`appendRequestEvent(${JSON.stringify(event, null, 2)})`);
    const request = requestHistory.get(event.seq);
    if (request) {
      if (!isEventEqual(event, request)) {
        throw new Error(
          `Re-entrant error: mismatch of events at seq ${event.seq}:\n${JSON.stringify(event, null, 2)} != ${JSON.stringify(request, null, 2)}`,
        );
      }
    } else {
      // console.log(`emitEvents.push(${JSON.stringify(event, null, 2)})`);
      // we've never seen this event before, so it's new and needs to be scheduled
      emitEvents.push(event);
    }

    // console.log(`replayedEvents.push(${JSON.stringify(event, null, 2)})`);
    replayedEvents.push(event);

    return new Promise<any>((resolve, reject) => {
      requestCallbacks.set(event.seq, [resolve, reject]);
    });
  }

  let seq = 0;

  const ctx: ExecutionContext = {
    task: (func: () => Promise<any>): Promise<any> =>
      appendRequestEvent({
        kind: "request",
        type: "task",
        seq: seq++,
        func,
      }),
    sleep: (seconds: number): Promise<void> =>
      appendRequestEvent({
        kind: "request",
        type: "sleep",
        seq: seq++,
        seconds,
      }),
  };

  // will be set with a result/error if the workflow completes, or undefined if it's still running
  let finalResult: Result<Out> | undefined = undefined;

  // kick off the user's workflow (this will synchronously produce the first phase of request events)
  workflow
    .handler(ctx, ...history.input)
    .then((result) => {
      console.log("workflow completed", result);
      finalResult = {
        value: result,
      };
    })
    .catch((error) => (finalResult = { error }));

  // the user's synchronous workflow code has now completed
  // ... we should now have a bunch of microtasks (Promise.then callbacks) on the microtask queue (which may have corresponding Response events in the history)

  // let's now go through the history, validate request parity and apply responses one at a time so that the async function progresses deterministically
  for (let i = 0; i < historyEvents.length; i++) {
    // an event being replayed from the history (or the incoming response events)
    const historyEvent = historyEvents[i];

    if (isResponseEvent(historyEvent)) {
      seq = historyEvent.seq + 1;
      // we found a response event, we should inject it into the replayed events
      replayedEvents.push(historyEvent);
    }

    // an event that was reproduced by the workflow function (by applying events to it)
    const replayedEvent = replayedEvents[i];

    // check that the event in the history was recorded at the exact same position in the replayed workflow
    if (replayedEvent === undefined) {
      // FATAL: this indicates the workflow function is not deterministic and cannot proceed
      throw new Error(
        `Mismatch when replaying history, expected ${JSON.stringify(historyEvent, null, 2)} but got undefined`,
      );
    } else if (!isEventEqual(historyEvent, replayedEvent)) {
      // FATAL: we got an event but it was not the expected one
      throw new Error(
        `Mismatch when replaying history, expected: ${JSON.stringify(historyEvent, null, 2)} but got ${JSON.stringify(replayedEvent, null, 2)}`,
      );
    }

    await new Promise((resolve) => {
      // we still have synchronous control here (the event loop has not progressed yet)

      if (historyEvent.kind === "response") {
        if (!requestCallbacks.has(historyEvent.replyTo)) {
          throw new Error(
            `Response without corresponding Request: ${JSON.stringify(historyEvent, null, 2)}`,
          );
        }
        // resolve the user's callbacks (schedule their continuation in the microtask queue)
        const [resolve, reject] = requestCallbacks.get(historyEvent.replyTo)!;
        if (historyEvent.type === "task") {
          if (historyEvent.result.error) {
            console.log("rejecting task", historyEvent);
            reject(new Error(historyEvent.result.error));
          } else {
            resolve(historyEvent.result.value);
          }
        } else {
          // resolve the timer
          resolve(undefined);
        }
      }

      // resolve this tick and progress to the next event (schedule the next event application in the microtask queue)
      // our next event application will execute AFTER the user's callback's synchronous control is released
      resolve(undefined);
    });
  }

  return new Promise((resolve) => {
    // let any existing microtasks complete before returning
    // -> the user's final synchronous code (running after their final await) will return the result on the next event loop iteration
    setImmediate(() => {
      resolve({
        output: finalResult as Result<Awaited<Out>>,
        events: emitEvents,
        history: replayedEvents,
      });
    });
  });
}
