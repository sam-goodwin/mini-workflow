export interface ExecutionContext {
  task<T>(func: () => Promise<T>): Promise<T>;
  sleep(duration: number, unit?: "ms" | "s"): Promise<void>;
}

export type WorkflowHandler<In extends any[], Out> = (
  ctx: ExecutionContext,
  ...args: In
) => Promise<Out>;

// export function execute(
//   workflow: Workflow<string, any[], any>,
//   task: SerializedTaskRequest,
// ) {
//   const runtime = new WorkflowRuntime();
//   return runtime.startExecution(workflow, input);
// }

export interface Workflow<Name extends string, in In extends any[], Out> {
  name: Name;
  handler: WorkflowHandler<In, Out>;
}

export function workflow<
  Name extends string,
  F extends WorkflowHandler<any[], any>,
>(
  name: Name,
  func: F,
): Workflow<
  Name,
  Parameters<F> extends [any, ...infer Rest] ? Rest : [],
  ReturnType<F>
> {
  return {
    name,
    handler: func,
  };
}
