/**
 * Shared harness for the bash-envrc specs: a real executor on a local
 * subprocess provider, a passthrough sandbox provider, and a fake `direnv`
 * executable whose behavior each test chooses. No test needs direnv installed.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { EnvrcBashExecutor, type EnvrcConfig } from '../src/index.ts'

/** Config defaults shared by every spec; a test overrides only what it exercises. */
export const DEFAULT_ENVRC: EnvrcConfig = {
  enabled: true,
  command: ['direnv', 'export', 'json'],
  timeoutMs: 10_000,
  allow: [],
  deny: [],
  failOnRefusal: true,
  cacheMs: 30_000,
}

/** The executor under test, with cache introspection for lifecycle assertions. */
export class ProbeExecutor extends EnvrcBashExecutor {
  /** Number of retained cache entries. */
  get cacheEntries(): number {
    return this.cache.size
  }
}

/** Sandbox provider that lets commands run unchanged; `danger-full-access` never calls it. */
class PassthroughSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy, _signal?: AbortSignal): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/** One booted executor and its owned context. */
export interface ExecutorHarness {
  readonly ctx: Context
  readonly executor: ProbeExecutor
}

/**
 * Boot the executor over a real local subprocess provider.
 * @param envrc - project-environment configuration overrides.
 * @param overrides - other executor config fields (grace period, timeouts).
 * @returns the context and the mounted executor.
 */
export async function mountExecutor(
  envrc: Partial<EnvrcConfig> = {},
  overrides: { graceMs?: number } = {},
): Promise<ExecutorHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ProbeExecutor, {
    graceMs: overrides.graceMs ?? 200,
    envrc: { ...DEFAULT_ENVRC, ...envrc },
  })
  return { ctx, executor: ctx.shell as ProbeExecutor }
}

/**
 * Resolve and run one command, returning the foreground result.
 * @param executor - the mounted executor.
 * @param request - the caller's shell request.
 * @returns the settled foreground result.
 */
export async function runCommand(executor: ProbeExecutor, request: ShellExecRequest): Promise<ShellRunResult> {
  return (await executor.execute(executor.resolve(request))).result()
}

/** One recorded fake-`direnv` invocation. */
export interface DirenvCall {
  /** Working directory the command ran in. */
  readonly cwd: string
  /** Arguments after the executable. */
  readonly args: string
}

/** Fake `direnv` behavior for one test. */
export interface FakeDirenvOptions {
  /** Stdout payload; absent prints nothing. */
  readonly stdout?: string
  /** Stderr payload; absent prints nothing. */
  readonly stderr?: string
  /** Exit status, default 0. */
  readonly exitCode?: number
  /** Seconds to sleep before printing, for timeout tests. */
  readonly sleepSeconds?: number
  /** Environment variable whose resolved value the fake records for assertions. */
  readonly probe?: string
}

/** A fake `direnv` executable and its invocation log. */
export interface FakeDirenv {
  /** Directory prepended to `PATH` by {@link withFakeDirenvOnPath}. */
  readonly binDir: string
  /** Recorded invocations in order. */
  calls(): Promise<DirenvCall[]>
  /** The value the probe variable had inside the fake process. */
  probe(): Promise<string>
}

/**
 * Write an executable shell script named `direnv` into a fresh directory.
 * @param root - test-owned directory that owns the script and its log.
 * @param options - printed output, status, and delay.
 * @returns the fake executable.
 */
export async function installFakeDirenv(root: string, options: FakeDirenvOptions): Promise<FakeDirenv> {
  const binDir = join(root, 'fake-bin')
  await mkdir(binDir, { recursive: true })
  const log = join(root, 'direnv-calls.log')
  const payload = join(root, 'direnv-export.json')
  if (options.stdout !== undefined) await writeFile(payload, options.stdout)
  const probeFile = join(root, 'direnv-probe.txt')
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$PWD|$*" >> '${log}'`,
    ...options.sleepSeconds === undefined ? [] : [`sleep ${String(options.sleepSeconds)}`],
    ...options.stderr === undefined ? [] : [`printf '%s' '${options.stderr}' >&2`],
    ...options.stdout === undefined ? [] : [`cat '${payload}'`],
    ...options.probe === undefined ? [] : [`printf '%s' "\${${options.probe}-<unset>}" > '${probeFile}'`],
    `exit ${String(options.exitCode ?? 0)}`,
    '',
  ].join('\n')
  const executable = join(binDir, 'direnv')
  await writeFile(executable, script)
  await chmod(executable, 0o755)
  return {
    binDir,
    probe: async () => (await readFile(probeFile, 'utf8').catch(() => '')),
    calls: async () => (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(line => line !== '')
      .map((line) => {
        const separator = line.indexOf('|')
        return { cwd: line.slice(0, separator), args: line.slice(separator + 1) }
      }),
  }
}

/**
 * Prepend a fake `direnv` directory to the process `PATH` the next spawn sees.
 * @param binDir - directory holding the fake executable.
 */
export function withFakeDirenvOnPath(binDir: string): void {
  vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`)
}

/** Create a fresh test-owned directory tree and schedule it for removal. */
const roots: string[] = []

/**
 * Create one test-owned temporary directory.
 * @param prefix - directory-name prefix for diagnostics.
 * @returns the absolute directory path.
 */
export async function makeRoot(prefix = 'dsh-bash-envrc-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Remove every directory {@link makeRoot} created. */
export async function removeRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

/**
 * Create a project directory holding an `.envrc` file.
 * @param root - test-owned directory.
 * @param content - `.envrc` contents; a comment by default.
 * @returns the project directory.
 */
export async function makeProject(root: string, content = '# project environment\n'): Promise<string> {
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, '.envrc'), content)
  return project
}
