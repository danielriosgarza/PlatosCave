/**
 * The execution binding of docs/design/connector.md §10.6. It lives in `@parallax/contracts`
 * (`kernelMessages.ts`) because the level 0 page binds executions by the same rules
 * (docs/design/open-site.md §13); the relay imports it from here.
 */
export {
  type BoundExecution,
  type DropReason,
  type ExecutionEvent,
  ExecutionMap,
  executeRequest,
  FINAL_EXECUTION_STATES,
  inputReply,
  isFinalExecution,
  type KernelEvent,
  KernelMessage,
  type KernelStateEvent,
  kernelEvent,
  nextExecutionState,
  nextKernelState,
  parentOf,
  parseKernelMessage,
} from '@parallax/contracts';
