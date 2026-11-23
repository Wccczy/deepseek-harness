/** Runs the GitHub CLI on the host with a scrubbed, non-interactive environment. */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { execa } from 'execa'

/** Complete output of one `gh` invocation that ran to an exit code. */
export interface GhOutput {
  /** Process exit code. */
  readonly exitCode: number
  /** Standard output without its final newline. */
  readonly stdout: string
  /** Standard error without its final newline. */
  readonly stderr: string
}

/** One `gh` invocation's standard input and account selection. */
export interface GhCall {
  /** Standard input, or omitted for none. */
  readonly input?: string
  /** `GH_CONFIG_DIR` for this invocation, overriding the inherited one. */
  readonly ghConfigDir?: string
}

/** Runs `gh` with literal arguments; rejects when the process cannot run to an exit code. */
export type GhRunner = (args: readonly string[], signal: AbortSignal, call?: GhCall) => Promise<GhOutput>

/** Resolved executable and limits for `gh`. */
export interface GhConfig {
  /** Executable name or absolute host path. */
  readonly ghCommand: string
  /** Deadline in milliseconds for one invocation. */
  readonly timeoutMs: number
  /** Maximum captured bytes per output stream. */
  readonly maxOutputBytes: number
}

/** Thrown when the `gh` executable cannot start, for example because it is not installed. */
export class GhUnavailableError extends Error {
  override name = 'GhUnavailableError'
}

/** Thrown when one invocation outlives `timeoutMs`; the process is killed. */
export class GhTimeoutError extends Error {
  override name = 'GhTimeoutError'
}

/** Thrown when an output stream exceeds `maxOutputBytes`; the process is killed. */
export class GhOutputLimitError extends Error {
  override name = 'GhOutputLimitError'
}

/**
 * Build a runner for `gh` on the host. The child inherits the scrubbed parent
 * environment, so variables whose names contain KEY, PASSWORD, SECRET, or
 * TOKEN never reach it and `gh` authenticates from its own credential store.
 * A call that names a `GH_CONFIG_DIR` reads that directory's account instead of
 * the inherited one; no other variable is added. Prompts, update notices,
 * pagers, and colors are disabled.
 * @param config - executable and limits.
 * @returns the runner.
 */
export function ghRunner(config: GhConfig): GhRunner {
  return async (args, signal, call) => {
    const result = await execa(config.ghCommand, args, {
      env: {
        ...scrubbedParentEnv(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1', CLICOLOR: '0',
        ...call?.ghConfigDir === undefined ? {} : { GH_CONFIG_DIR: call.ghConfigDir },
      },
      extendEnv: false,
      ...call?.input === undefined ? { stdin: 'ignore' as const } : { input: call.input },
      reject: false,
      timeout: config.timeoutMs,
      cancelSignal: signal,
      maxBuffer: config.maxOutputBytes,
    })
    const command = ['gh', ...args.slice(0, 1)].join(' ')
    if (result.isCanceled) throw signal.reason
    if (result.timedOut) throw new GhTimeoutError(`${command} timed out after ${config.timeoutMs}ms`)
    if (result.isMaxBuffer) throw new GhOutputLimitError(`${command} output exceeds maxOutputBytes`)
    // A result without an exit code failed before the process ran; execa then always sets shortMessage.
    if (result.exitCode === undefined) throw new GhUnavailableError(`gh could not start: ${String(result.shortMessage)}`)
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}
