/**
 * Pure helper behavior (discovery, parsing, cache, readers) plus the provider
 * failure paths that only a scripted subprocess provider can produce.
 */

import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvrcConfig } from '../src/index.ts'
import {
  EnvrcCache,
  envrcCacheKey,
  findEnvrc,
  parseEnvrcExport,
  realDirectoryOf,
} from '../src/envrc.ts'
import { collectReaders } from '../src/subprocess.ts'
import { DEFAULT_ENVRC, ProbeExecutor, makeProject, makeRoot, removeRoots } from './support.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await removeRoots()
})

/** A reader that always returns the whole stream. */
function reader(text: string, lossy = false): SubprocessOutputReader {
  return {
    readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy }),
  }
}

/** The stable code of the error a call throws, or undefined when it returns. */
function codeOf(run: () => unknown): unknown {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: unknown }).code
  }
}

/** A handle settled with the given outcome and collected text. */
function settledHandle(options: {
  stdout?: string
  stderr?: string
  exitCode?: number
  lossy?: boolean
  collected?: SubprocessCollectedOutputs
} = {}): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: options.collected ?? {
      stdout: reader(options.stdout ?? '', options.lossy ?? false),
      stderr: reader(options.stderr ?? ''),
    },
    done: Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null } satisfies SubprocessOutcome),
    terminate: () => {},
    waitForExit: async () => true,
  }
}

/** A handle whose spawn rejected with the given error. */
function rejectedHandle(error: Error): SubprocessHandle {
  return { ...settledHandle(), done: Promise.reject(error) }
}

/** Subprocess provider whose spawn is scripted per test. */
class ScriptedSubprocess extends SubprocessRuntime {
  handler: (spec: SubprocessSpawnSpec) => SubprocessHandle = () => settledHandle()

  async resolveExecutable(command: string): Promise<string> {
    return command
  }

  async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return { platform: 'posix' }
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.handler(spec)
  }

  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('scripted terminal is not used')
  }
}

/** Passthrough sandbox so the scripted composition never confines. */
class LenientSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/** Mount the executor on top of a scripted subprocess provider. */
async function mountScripted(
  handler: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  envrc: Partial<EnvrcConfig> = {},
): Promise<ProbeExecutor> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ScriptedSubprocess)
  const subprocess = ctx.subprocess as ScriptedSubprocess
  subprocess.handler = handler
  await ctx.plugin(LenientSandbox)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
  await ctx.plugin(ProbeExecutor, { graceMs: 200, envrc: { ...DEFAULT_ENVRC, ...envrc } })
  return ctx.shell as ProbeExecutor
}

describe('discovery', () => {
  it('returns the nearest .envrc and walks to the root without one', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    await mkdir(join(project, 'nested'), { recursive: true })
    const found = await findEnvrc(await realpath(join(project, 'nested')))
    expect(found?.directory).toBe(await realpath(project))
    expect(found?.file).toBe(join(await realpath(project), '.envrc'))

    await mkdir(join(root, 'bare'), { recursive: true })
    expect(await findEnvrc(await realpath(join(root, 'bare')))).toBeUndefined()
  })

  it('keeps walking when a path component is not a directory', async () => {
    const root = await makeRoot()
    const file = join(root, 'plain.txt')
    await writeFile(file, 'x')
    expect(await findEnvrc(join(file, 'child'))).toBeUndefined()
  })

  it('reports a discovery error other than a missing path', async () => {
    const root = await makeRoot()
    await expect(findEnvrc(join(root, 'x'.repeat(5_000)))).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
  })

  it('canonicalizes an existing directory and rejects a missing one', async () => {
    const root = await makeRoot()
    expect(await realDirectoryOf(root)).toBe(await realpath(root))
    expect(await realDirectoryOf(join(root, 'missing'))).toBeUndefined()
  })
})

describe('parsing', () => {
  it('accepts a JSON object and skips null unset markers', () => {
    expect(parseEnvrcExport('{"A":"1","B":null,"C":"3"}')).toEqual({ A: '1', C: '3' })
  })

  it('treats an empty export as the no-change result', () => {
    expect(parseEnvrcExport('')).toEqual({})
    expect(parseEnvrcExport('\n  \n')).toEqual({})
  })

  it('rejects malformed, non-object, and non-string values', () => {
    expect(codeOf(() => parseEnvrcExport('not-json'))).toBe('ENVRC_OUTPUT')
    expect(codeOf(() => parseEnvrcExport('["A"]'))).toBe('ENVRC_OUTPUT')
    expect(codeOf(() => parseEnvrcExport('{"A":1}'))).toBe('ENVRC_OUTPUT')
  })
})

describe('cache key and cache', () => {
  it('keys a project directory on the .envrc identity and a bare directory separately', () => {
    const location = { file: '/p/.envrc', directory: '/p', mtimeMs: 12, size: 34 }
    expect(envrcCacheKey('/p', location)).toBe('/p\u0000/p/.envrc\u000012\u000034')
    expect(envrcCacheKey('/p', undefined)).toBe('/p\u0000')
  })

  it('expires entries, reports size, and clears', async () => {
    const cache = new EnvrcCache(10)
    cache.set('k', { A: '1' })
    expect(cache.size).toBe(1)
    expect(cache.get('k')?.environment).toEqual({ A: '1' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cache.get('k')).toBeUndefined()
    expect(cache.size).toBe(0)

    cache.set('k', undefined)
    expect(cache.get('k')?.environment).toBeUndefined()
    cache.clear()
    expect(cache.size).toBe(0)
  })
})

describe('collected readers', () => {
  it('returns both readers and rejects a handle without them', () => {
    const handle = settledHandle()
    expect(collectReaders(handle, 'direnv').stdout.readFrom(0).text).toBe('')
    expect(codeOf(() => collectReaders(settledHandle({ collected: {} }), 'direnv'))).toBe('ENVRC_OUTPUT')
  })
})

describe('provider failures', () => {
  it('maps a synchronous spawn rejection to ENVRC_FAILED', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const executor = await mountScripted(() => {
      throw Object.assign(new Error('spawn refused'), { code: 'EACCES' })
    })
    await expect(executor.execute(executor.resolve({ command: 'true', workdir: project })))
      .rejects.toMatchObject({ code: 'ENVRC_FAILED' })
  })

  it('maps an asynchronous spawn rejection to ENVRC_FAILED', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const executor = await mountScripted(() => rejectedHandle(Object.assign(new Error('spawn refused'), { code: 'EACCES' })))
    await expect(executor.execute(executor.resolve({ command: 'true', workdir: project })))
      .rejects.toMatchObject({ code: 'ENVRC_FAILED' })
  })

  it('maps a missing program in an asynchronous rejection to ENVRC_UNAVAILABLE', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const executor = await mountScripted(() => rejectedHandle(Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' })))
    await expect(executor.execute(executor.resolve({ command: 'true', workdir: project })))
      .rejects.toMatchObject({ code: 'ENVRC_UNAVAILABLE' })
  })

  it('fails with ENVRC_OUTPUT when the provider drops the collected readers', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const executor = await mountScripted(() => settledHandle({ collected: {} }))
    await expect(executor.execute(executor.resolve({ command: 'true', workdir: project })))
      .rejects.toMatchObject({ code: 'ENVRC_OUTPUT' })
  })

})
