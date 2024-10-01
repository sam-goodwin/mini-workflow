export interface ExecutionContext {
  task<T>(func: () => Promise<T>): Promise<T>;
  sleep(seconds: number): Promise<void>;
}

export type WorkflowHandler<In extends any[], Out> = (
  ctx: ExecutionContext,
  ...args: In
) => Promise<Out>;

export interface Workflow<Name extends string, in In extends any[], Out> {
  name: Name;
  handler: WorkflowHandler<In, Out>;
}

// TODO(sam): i hate globals, should we force users to be explicit instead of implicit?
const globalWorkflows = new Map<string, Workflow<string, any[], any>>();

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
  if (globalWorkflows.has(name)) {
    throw new Error(`Workflow ${name} already exists`);
  }
  const workflow = {
    name,
    handler: func,
  };
  globalWorkflows.set(name, workflow);
  return workflow;
}

export function getWorkflowFromExecutionId(executionId: string) {
  const [workflowName] = executionId.split(":");
  return getWorkflow(workflowName);
}

export function getWorkflow<Name extends string>(name: Name) {
  const workflow = globalWorkflows.get(name) as
    | Workflow<Name, any[], any>
    | undefined;
  if (!workflow) {
    throw new Error(`Workflow ${name} not found`);
  }
  return workflow;
}
