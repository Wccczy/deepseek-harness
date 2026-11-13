/**
 * Failures raised while deriving a command's environment from its project
 * `.envrc`. Every failure is loud by default: a silently missing environment
 * reproduces the defect this executor exists to fix.
 * @module @deepseek-ai/dsh-bash-envrc/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Stable machine-routable codes for one project-environment resolution.
 * `ENVRC_REFUSED` is the one refusal a deployment may downgrade through config;
 * the others always fail the command.
 */
export type EnvrcErrorCode =
  /** `direnv export` exited non-zero, normally because the `.envrc` is not approved. */
  | 'ENVRC_REFUSED'
  /** The configured command could not be started (missing executable). */
  | 'ENVRC_UNAVAILABLE'
  /** The configured command did not finish within `envrc.timeoutMs`. */
  | 'ENVRC_TIMEOUT'
  /** The configured command exceeded the output bound or printed unparseable output. */
  | 'ENVRC_OUTPUT'
  /** The configured command failed for another reason, such as a foreign exit code. */
  | 'ENVRC_FAILED'

/**
 * One project-environment failure. The message names the directory, the
 * command outcome, and the safe next action; `code` is the routing identity.
 */
export class EnvrcError extends HarnessError {
  constructor(code: EnvrcErrorCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}
