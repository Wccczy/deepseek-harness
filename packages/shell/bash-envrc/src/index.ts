/**
 * Bash executor that derives each command's environment from the project's
 * `.envrc` through `direnv export json`, merged beneath the caller's explicit
 * environment map. Project variables never overwrite the executor's own
 * vocabulary: bootstrap and credential-shaped names are dropped, and the
 * subprocess service's managed `DSH_*` snapshot still merges last.
 * @module @deepseek-ai/dsh-bash-envrc
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { selectEnvironment } from './deny.ts'
import { collectReaders } from './subprocess.ts'
import {
  EnvrcCache,
  findEnvrc,
  envrcCacheKey,
  parseEnvrcExport,
  realDirectoryOf,
  type EnvrcLocation,
} from './envrc.ts'
import { EnvrcError } from './errors.ts'

export { EnvrcError } from './errors.ts'
export type { EnvrcErrorCode } from './errors.ts'
export { BOOTSTRAP_DENY_NAMES, BOOTSTRAP_DENY_PREFIXES } from './deny.ts'

/**
 * Output bound for one `direnv export json` invocation. The real export of a
 * project environment stays far below this; the bound exists so a broken
 * `.envrc` that prints an unbounded stream fails the command instead of
 * exhausting the harness process.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** Captured stderr bound for one resolution; the whole excerpt rides in the failure message. */
const MAX_ERROR_BYTES = 4 * 1024

/** Project-environment loading knobs. */
export interface EnvrcConfig {
  /** Resolve the project environment at all; false makes this executor behave like its parent. */
  enabled: boolean
  /** Command that prints direnv's JSON export; argv, never shell-interpreted. */
  command: string[]
  /** Deadline for one resolution, independent of the command's own timeout. */
  timeoutMs: number
  /**
   * When non-empty, only these names may pass (case-insensitive). The deny
   * lists still apply first, so an allow entry cannot re-admit a bootstrap or
   * credential name.
   */
  allow: string[]
  /** Extra names refused on top of the built-in bootstrap, `DIRENV_*`, and credential lists. */
  deny: string[]
  /** Fail the command when direnv refuses the `.envrc`; false degrades to the ambient environment. */
  failOnRefusal: boolean
  /** How long a resolved environment (and an absent `.envrc`) stays cached, in milliseconds. */
  cacheMs: number
}

/** Validated plugin configuration: the local executor's knobs plus the project-environment fields. */
export interface Config extends LocalConfig {
  /** Project `.envrc` loading configuration. */
  envrc: EnvrcConfig
}

/**
 * The parent executor's configuration fields, repeated here because schemastery
 * rejects a volatile field inside an intersect and the config catalog walks only
 * object schemas. `tests/config-schema.spec.ts` compares every field and default
 * with `LocalBashExecutor.Config.dict`, so a parent change fails this package
 * instead of drifting silently.
 */
const EnvrcConfigFields = {
  cwd: z.string().volatile(),
  timeoutMs: z.number().default(120_000).volatile(),
  maxTimeoutMs: z.number().default(600_000).volatile(),
  maxOutputBytes: z.number().default(64_000).volatile(),
  maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
  graceMs: z.number().default(3_000).volatile(),
}

/**
 * Project-environment `.envrc` executor. It registers as `ctx.shell` in place
 * of `dsh-bash-sandbox`, resolves the environment of each resolved spec's
 * working directory through `direnv export json`, and hands the filtered
 * difference to the sandbox executor's own `execute`, so confinement,
 * deadlines, background handles, and output spilling keep their exact
 * semantics. A directory without an `.envrc` passes through untouched.
 */
export class EnvrcBashExecutor extends SandboxBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  static override Config = z.object({
    ...EnvrcConfigFields,
    envrc: z.object({
      enabled: z.boolean().default(true),
      command: z.array(z.string()).min(1).default(['direnv', 'export', 'json']),
      timeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      failOnRefusal: z.boolean().default(true),
      cacheMs: z.number().min(0).default(30_000),
    }).default({}),
  })

  /** Resolved project-environment configuration; read per command. */
  private readonly envrc: EnvrcConfig
  /** Per-instance resolution cache, cleared when this plugin fiber unloads. */
  protected readonly cache: EnvrcCache

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.envrc = config.envrc
    this.cache = new EnvrcCache(this.envrc.cacheMs)
    ctx.effect(() => () => { this.cache.clear() })
  }

  /**
   * Resolve the project environment of the spec's working directory and run
   * the command with it merged beneath the caller's explicit `env`. The
   * presence of an `.envrc` decides whether the environment participates at
   * all; a missing directory resolution leaves the command's own error alone.
   * @param spec - the resolved execution spec.
   * @returns the prepared handle from the sandbox executor.
   * @throws EnvrcError when the configured command fails and the failure is
   *   not a downgraded refusal.
   */
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    if (!this.envrc.enabled) return super.execute(spec)
    const environment = await this.projectEnvironment(spec.workdir, spec.signal)
    if (environment === undefined) return super.execute(spec)
    return super.execute({ ...spec, env: { ...environment, ...spec.env } })
  }

  /**
   * Resolve one working directory, consulting the cache before running the
   * configured command. Only successful and absent-file results are cached.
   */
  private async projectEnvironment(
    workdir: string,
    signal: AbortSignal | undefined,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    signal?.throwIfAborted()
    const directory = await realDirectoryOf(workdir)
    if (directory === undefined) return undefined
    const location = await findEnvrc(directory)
    const key = envrcCacheKey(directory, location)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached.environment
    if (location === undefined) {
      this.cache.set(key, undefined)
      return undefined
    }
    const exported = await this.exportEnvironment(directory, location, signal)
    if (exported === undefined) return undefined
    const environment = selectEnvironment(Object.entries(exported), {
      allow: this.envrc.allow,
      deny: this.envrc.deny,
      baseline: process.env,
    })
    this.cache.set(key, environment)
    return environment
  }

  /**
   * Run the configured command in the project directory and parse its JSON
   * export. Refusals either fail the command or, under `failOnRefusal: false`,
   * log and return undefined so the command runs with the ambient environment.
   */
  private async exportEnvironment(
    directory: string,
    location: EnvrcLocation,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, string> | undefined> {
    signal?.throwIfAborted()
    const commandLine = this.envrc.command.join(' ')
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(this.timedOut(directory))
    }, this.envrc.timeoutMs)
    const forwardAbort = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      let handle: SubprocessHandle
      try {
        handle = this.ctx.subprocess.spawn({
          argv: [...this.envrc.command],
          cwd: directory,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_OUTPUT_BYTES },
            stderr: { maxBytes: MAX_ERROR_BYTES },
          },
          graceMs: this.config.graceMs.get(),
          // Strip inherited direnv bookkeeping so resolution describes the
          // target directory, not whatever project the harness was launched
          // from: a stale DIRENV_DIFF makes direnv consider the environment
          // already applied and print nothing.
          env: {
            DIRENV_DIFF: undefined,
            DIRENV_DIR: undefined,
            DIRENV_FILE: undefined,
            DIRENV_WATCHES: undefined,
          },
          signal: controller.signal,
        })
      } catch (error) {
        signal?.throwIfAborted()
        throw this.startFailure(directory, commandLine, error)
      }
      const outcome = await handle.done.then(
        settled => ({ settled }),
        (error: unknown) => ({ error }),
      )
      if (controller.signal.aborted && controller.signal.reason instanceof EnvrcError) {
        throw controller.signal.reason
      }
      signal?.throwIfAborted()
      if ('error' in outcome) throw this.startFailure(directory, commandLine, outcome.error)
      const readers = collectReaders(handle, commandLine)
      const stdout = readers.stdout.readFrom(0)
      const stderr = readers.stderr.readFrom(0)
      if (stdout.lossy) {
        throw new EnvrcError(
          'ENVRC_OUTPUT',
          `bash-envrc: ${commandLine} printed more than ${String(MAX_OUTPUT_BYTES)} bytes for ${directory}; reduce what the .envrc exports`,
        )
      }
      if (outcome.settled.exitCode !== 0) {
        const detail = stderr.text.trim()
        const suffix = detail === '' ? '' : `: ${detail}`
        if (outcome.settled.exitCode !== 1) {
          throw new EnvrcError(
            'ENVRC_FAILED',
            `bash-envrc: ${commandLine} failed in ${directory} (exit ${String(outcome.settled.exitCode)})${suffix}`,
          )
        }
        if (!this.envrc.failOnRefusal) {
          this.ctx.logger.warn(`bash-envrc: ${commandLine} refused ${location.file}; running without its environment${suffix}`)
          return undefined
        }
        throw new EnvrcError(
          'ENVRC_REFUSED',
          `bash-envrc: ${commandLine} refused to export ${directory} (exit 1)${suffix}. Review the .envrc, then run \`direnv allow ${directory}\` to approve its current content`,
        )
      }
      return parseEnvrcExport(stdout.text)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  /**
   * Convert a provider start failure: a missing program is a configuration
   * problem the caller can fix; anything else is a failed resolution.
   */
  private startFailure(directory: string, commandLine: string, error: unknown): EnvrcError {
    if (isMissingExecutable(error)) {
      return new EnvrcError(
        'ENVRC_UNAVAILABLE',
        `bash-envrc: cannot run \`${commandLine}\` in ${directory}; install direnv or point envrc.command at an executable that prints \`direnv export json\` output`,
        { cause: error },
      )
    }
    return new EnvrcError(
      'ENVRC_FAILED',
      `bash-envrc: \`${commandLine}\` failed to start in ${directory}`,
      { cause: error },
    )
  }

  /** The timeout failure, shared by the preparation and settlement paths. */
  private timedOut(directory: string): EnvrcError {
    return new EnvrcError(
      'ENVRC_TIMEOUT',
      `bash-envrc: direnv export for ${directory} did not finish within ${String(this.envrc.timeoutMs)} ms; raise envrc.timeoutMs or fix the .envrc`,
    )
  }
}

/** Whether a provider rejection names an absent executable or working directory. */
function isMissingExecutable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export default EnvrcBashExecutor
