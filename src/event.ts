export type WorkflowEvent = RequestEvent | ResponseEvent;
export type RequestEvent = SleepRequest | TaskRequest;
export type ResponseEvent = SleepResponse | TaskResponse;

export interface StartWorkflowEvent {
  kind: "start";
}

export type EventLog = [StartWorkflowEvent, ...Serialized<WorkflowEvent>[]];

export type UnorderedEvent = Unordered<TaskResponse> | Unordered<SleepResponse>;

export type Unordered<E extends WorkflowEvent> = E extends TaskResponse
  ? // ran into weird problems if TaskResponse's intersection types were not being reflected unless this is distributed manually
    Omit<E, "seq">
  : Omit<E, "seq">;

export type Serialized<E extends WorkflowEvent> = E extends TaskRequest
  ? Omit<TaskRequest, "func">
  : E;

export function serializeWorkflowEvent(
  event: WorkflowEvent,
): Serialized<WorkflowEvent> {
  if (event.kind === "request" && event.type === "task") {
    const { func, ...rest } = event;
    return rest;
  }
  return event;
}

export function isRequestEvent<
  E extends WorkflowEvent | Serialized<WorkflowEvent>,
>(
  event: E,
): event is E & {
  kind: "request";
} {
  return event.kind === "request";
}

export function isResponseEvent<
  E extends WorkflowEvent | UnorderedEvent | Serialized<WorkflowEvent>,
>(
  event: E,
): event is E & {
  kind: "response";
} {
  return event.kind === "response";
}

export function isEventEqual(
  a: WorkflowEvent | UnorderedEvent | Serialized<WorkflowEvent>,
  b: WorkflowEvent | UnorderedEvent | Serialized<WorkflowEvent>,
): boolean {
  if (a.kind !== b.kind || a.type !== b.type) {
    return false;
  }
  if ("seq" in a && "seq" in b) {
    if (a.seq !== b.seq) {
      return false;
    }
  } else if ("seq" in a || "seq" in b) {
    return false;
  }

  if (a.kind === "request" && a.type === "sleep") {
    return a.seconds === (b as SleepRequest).seconds;
  }
  return true;
}

export interface SleepRequest {
  kind: "request";
  type: "sleep";
  seq: number;
  seconds: number;
}

export interface SleepResponse {
  kind: "response";
  type: "sleep";
  seq: number;
  /**
   * Sequence number of the {@link SleepRequest} this reply corresponds to.
   */
  replyTo: number;
}

export interface TaskRequest {
  kind: "request";
  type: "task";
  seq: number;
  // TODO(sam): do we want to record inputs and function name so that we can validate request task parity?

  // this will not be serialized in the history, and instead the re-entrant workflow function needs to be replayed to reproduce the closure
  func: () => Promise<any>;
}

export type TaskResponse = {
  kind: "response";
  type: "task";
  seq: number;
  /**
   * Sequence number of the {@link TaskRequest} this corresponds to.
   */
  replyTo: number;
} & (
  | {
      result: any;
      error?: never;
    }
  | {
      error: string;
      result?: never;
    }
);
