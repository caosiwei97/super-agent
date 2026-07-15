import {
  executeProcess,
  type ProcessExecutionOptions,
  type ProcessExecutionResult,
} from './process-executor.js'

/**
 * Narrow process lifecycle port shared by execution backends.
 *
 * Keeping the existing implementation behind this class preserves its tested
 * argv-only spawning, output budget, deadline and process-group cleanup while
 * allowing M3 backends to add isolation without duplicating lifecycle code.
 */
export class ProcessController {
  execute(options: ProcessExecutionOptions): Promise<ProcessExecutionResult> {
    return executeProcess(options)
  }
}
