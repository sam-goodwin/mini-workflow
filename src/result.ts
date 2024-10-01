export type Result<T> =
  | {
      value: T;
      error?: never;
    }
  | {
      error: any;
      value?: never;
    };
