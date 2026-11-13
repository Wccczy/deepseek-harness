/**
 * Behavior of the project-environment executor over a real local subprocess
 * provider. A fake `direnv` executable supplies exports, refusals, delays, and
 * failures, so the suite passes on a host without direnv installed.
 */

import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import {
  installFakeDirenv,
  makeProject,
  makeRoot,
  mountExecutor,
  removeRoots,
  runCommand,
  withFakeDirenvOnPath,
} from './support.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await removeRoots()
})

/** Mount an executor whose context is disposed by the suite's afterEach. */
async function mount(envrc: Parameters<typeof mountExecutor>[0] = {}, overrides: Parameters<typeof mountExecutor>[1] = {}) {
  const harness = await mountExecutor(envrc, overrides)
  contexts.push(harness.ctx)
  return harness
}

/** The real location a project directory reports through the platform's temporary root. */
function canonical(path: string): Promise<string> {
  return realpath(path)
}

describe('project environment resolution', () => {
  it('merges the export beneath the caller-provided environment', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, {
      stdout: JSON.stringify({ PROJECT_VAR: 'from-envrc', SHARED: 'from-envrc' }),
    })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const result = await runCommand(executor, {
      command: 'printf "%s|%s" "$PROJECT_VAR" "$SHARED"',
      workdir: project,
      env: { SHARED: 'caller' },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('from-envrc|caller')
    expect(await direnv.calls()).toEqual([{ cwd: await canonical(project), args: 'export json' }])
  })

  it('drops bootstrap, managed, direnv-bookkeeping, and credential names', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, {
      stdout: JSON.stringify({
        PATH: '/evil/bin',
        BASH_ENV: '/evil/env',
        LD_PRELOAD: '/evil.so',
        DSH_SESSION_ID: 'forged',
        GH_TOKEN: 'secret',
        MY_API_KEY: 'secret',
        SAFE_VALUE: 'ok',
      }),
    })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const result = await runCommand(executor, {
      command: 'printf "%s|%s|%s|%s|%s|%s" "${PATH-<unset>}" "${BASH_ENV-<unset>}" "${LD_PRELOAD-<unset>}" "${DSH_SESSION_ID-<unset>}" "${GH_TOKEN-<unset>}" "${SAFE_VALUE-<unset>}"',
      workdir: project,
    })

    expect(result.stdout.text).toBe(
      `${process.env['PATH'] ?? ''}|<unset>|<unset>|<unset>|<unset>|ok`,
    )
  })

  it('forwards every non-denied variable when allow is empty', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, {
      stdout: JSON.stringify({
        GH_CONFIG_DIR: '/accounts/work',
        GOPATH: '/go',
        JAVA_HOME: '/jdk',
        NODE_EXTRA_CA_CERTS: '/ca.pem',
      }),
    })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const result = await runCommand(executor, {
      command: 'printf "%s|%s|%s|%s" "${GH_CONFIG_DIR-<unset>}" "${GOPATH-<unset>}" "${JAVA_HOME-<unset>}" "${NODE_EXTRA_CA_CERTS-<unset>}"',
      workdir: project,
    })

    // NODE_EXTRA_CA_CERTS is bootstrap-only inside app-boot's list, so the
    // default deny list keeps it out even though allow is empty.
    expect(result.stdout.text).toBe('/accounts/work|/go|/jdk|<unset>')
  })

  it('narrows to the configured allow list and still applies the deny list', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, {
      stdout: JSON.stringify({ GH_CONFIG_DIR: '/accounts/work', GOPATH: '/go', DSH_SESSION_ID: 'forged' }),
    })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount({ allow: ['GH_CONFIG_DIR', 'DSH_SESSION_ID'] })

    const result = await runCommand(executor, {
      command: 'printf "%s|%s|%s" "${GH_CONFIG_DIR-<unset>}" "${GOPATH-<unset>}" "${DSH_SESSION_ID-<unset>}"',
      workdir: project,
    })

    expect(result.stdout.text).toBe('/accounts/work|<unset>|<unset>')
  })

  it('adds configured deny names to the built-in lists', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, {
      stdout: JSON.stringify({ PROJECT_VAR: 'denied', OTHER_VAR: 'allowed' }),
    })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount({ deny: ['PROJECT_VAR'] })

    const result = await runCommand(executor, {
      command: 'printf "%s|%s" "${PROJECT_VAR-<unset>}" "${OTHER_VAR-<unset>}"',
      workdir: project,
    })

    expect(result.stdout.text).toBe('<unset>|allowed')
  })

  it('finds the nearest .envrc above the working directory', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const nested = join(project, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    const direnv = await installFakeDirenv(root, { stdout: JSON.stringify({ PROJECT_FROM_ABOVE: 'yes' }) })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const result = await runCommand(executor, {
      command: 'printf "%s" "${PROJECT_FROM_ABOVE-<unset>}"',
      workdir: nested,
    })

    expect(result.stdout.text).toBe('yes')
    expect(await direnv.calls()).toEqual([{ cwd: await canonical(nested), args: 'export json' }])
  })

  it('resolves a symlinked working directory through its real path', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const link = join(root, 'project-link')
    await symlink(project, link)
    const direnv = await installFakeDirenv(root, { stdout: JSON.stringify({ LINKED_VAR: 'yes' }) })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const result = await runCommand(executor, {
      command: 'printf "%s" "${LINKED_VAR-<unset>}"',
      workdir: link,
    })

    expect(result.stdout.text).toBe('yes')
    expect((await direnv.calls())[0]?.cwd).toBe(await canonical(project))
  })

  it('treats an empty direnv export as no environment and runs the command', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: '' })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const result = await runCommand(executor, {
      command: 'printf "%s" "${PROJECT_VAR-<unset>}"',
      workdir: project,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('<unset>')
    expect(await direnv.calls()).toHaveLength(1)
  })

  it('strips inherited direnv bookkeeping from the resolution command', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: '{}', probe: 'DIRENV_DIFF' })
    withFakeDirenvOnPath(direnv.binDir)
    vi.stubEnv('DIRENV_DIFF', 'stale-launch-shell-state')
    const { executor } = await mount()

    await runCommand(executor, { command: 'true', workdir: project })

    expect(await direnv.probe()).toBe('<unset>')
  })

  it('passes through a directory without .envrc and never runs the command', async () => {
    const root = await makeRoot()
    const project = join(root, 'plain')
    await mkdir(project, { recursive: true })
    const direnv = await installFakeDirenv(root, { stdout: JSON.stringify({ UNUSED: 'x' }) })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const result = await runCommand(executor, {
      command: 'printf "%s" "${UNUSED-<unset>}"',
      workdir: project,
    })

    expect(result.stdout.text).toBe('<unset>')
    expect(await direnv.calls()).toEqual([])
  })

  it('keeps a working directory the platform cannot resolve on its own error path', async () => {
    const root = await makeRoot()
    const { executor } = await mount()

    await expect(runCommand(executor, {
      command: 'printf should-not-run',
      workdir: join(root, 'missing-directory'),
    })).rejects.toThrow()
  })

  it('behaves like the parent executor when disabled', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: JSON.stringify({ PROJECT_VAR: 'from-envrc' }) })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount({ enabled: false })

    const result = await runCommand(executor, {
      command: 'printf "%s" "${PROJECT_VAR-<unset>}"',
      workdir: project,
    })

    expect(result.stdout.text).toBe('<unset>')
    expect(await direnv.calls()).toEqual([])
  })
})

describe('failures', () => {
  it('fails the command when direnv refuses the .envrc', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, {
      exitCode: 1,
      stderr: 'direnv: error .envrc is blocked.',
    })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const failure = runCommand(executor, {
      command: `printf ran > '${join(root, 'marker')}'`,
      workdir: project,
    })

    await expect(failure).rejects.toMatchObject({ name: 'EnvrcError', code: 'ENVRC_REFUSED' })
    await expect(failure).rejects.toThrow(/direnv allow .*project/)
    await expect(failure).rejects.toThrow(/blocked/)
  })

  it('reports a refusal that printed no stderr detail', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { exitCode: 1 })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    await expect(runCommand(executor, { command: 'true', workdir: project }))
      .rejects.toThrow(/\(exit 1\)\. Review the \.envrc/)
  })

  it('degrades to the ambient environment when failOnRefusal is false', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { exitCode: 1, stderr: 'direnv: error .envrc is blocked.' })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor, ctx } = await mount({ failOnRefusal: false })
    const warn = vi.spyOn(ctx.logger, 'warn')

    const result = await runCommand(executor, {
      command: 'printf "%s" "${PROJECT_VAR-<unset>}"',
      workdir: project,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('<unset>')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('running without its environment'))
  })

  it('fails with ENVRC_UNAVAILABLE when the configured command does not exist', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const { executor } = await mount({ command: ['dsh-bash-envrc-missing-executable', 'export', 'json'] })

    await expect(runCommand(executor, { command: 'true', workdir: project }))
      .rejects.toMatchObject({ code: 'ENVRC_UNAVAILABLE' })
  })

  it('fails with ENVRC_TIMEOUT when the command outlives envrc.timeoutMs', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: '{}', sleepSeconds: 5 })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount({ timeoutMs: 150 })
    const started = Date.now()

    await expect(runCommand(executor, { command: 'true', workdir: project }))
      .rejects.toMatchObject({ code: 'ENVRC_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('fails with ENVRC_OUTPUT when the export exceeds the output bound', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const oversized = `{"BIG":"${'x'.repeat(1024 * 1024 + 1)}"}`
    const direnv = await installFakeDirenv(root, { stdout: oversized })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    await expect(runCommand(executor, { command: 'true', workdir: project }))
      .rejects.toMatchObject({ code: 'ENVRC_OUTPUT' })
  })

  it('fails with ENVRC_OUTPUT when the command prints malformed JSON', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: 'not-json' })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    await expect(runCommand(executor, { command: 'true', workdir: project }))
      .rejects.toMatchObject({ code: 'ENVRC_OUTPUT' })
  })

  it('reports an exit status other than the refusal status as ENVRC_FAILED', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { exitCode: 2, stderr: 'direnv: parse error' })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const failure = runCommand(executor, { command: 'true', workdir: project })
    await expect(failure).rejects.toMatchObject({ code: 'ENVRC_FAILED' })
    await expect(failure).rejects.toThrow(/parse error/)
  })

  it('propagates caller cancellation through the resolution command', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: '{}', sleepSeconds: 5 })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()
    const controller = new AbortController()
    const reason = new Error('caller cancelled the command')
    const pending = executor.execute(executor.resolve({
      command: 'true',
      workdir: project,
      signal: controller.signal,
    }))
    setTimeout(() => { controller.abort(reason) }, 100)

    await expect(pending).rejects.toBe(reason)
  })

  it('rejects an already-aborted caller before resolving anything', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: '{}' })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()
    const controller = new AbortController()
    const reason = new Error('already aborted')
    controller.abort(reason)

    await expect(executor.execute(executor.resolve({
      command: 'true',
      workdir: project,
      signal: controller.signal,
    }))).rejects.toBe(reason)
    expect(await direnv.calls()).toEqual([])
  })
})

describe('resolution cache', () => {
  it('reuses a resolved environment until the .envrc changes', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: JSON.stringify({ CACHED_VAR: 'first' }) })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount()

    const first = await runCommand(executor, { command: 'printf "%s" "${CACHED_VAR-<unset>}"', workdir: project })
    const second = await runCommand(executor, { command: 'printf "%s" "${CACHED_VAR-<unset>}"', workdir: project })
    expect(first.stdout.text).toBe('first')
    expect(second.stdout.text).toBe('first')
    expect(await direnv.calls()).toHaveLength(1)
    expect(executor.cacheEntries).toBe(1)

    await writeFile(join(project, '.envrc'), '# a longer project environment file\n')
    await writeFile(join(root, 'direnv-export.json'), JSON.stringify({ CACHED_VAR: 'second' }))
    const third = await runCommand(executor, { command: 'printf "%s" "${CACHED_VAR-<unset>}"', workdir: project })
    expect(third.stdout.text).toBe('second')
    expect(await direnv.calls()).toHaveLength(2)
  })

  it('re-resolves after cacheMs elapses', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: '{}' })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor } = await mount({ cacheMs: 1_000 })

    await runCommand(executor, { command: 'true', workdir: project })
    await runCommand(executor, { command: 'true', workdir: project })
    expect(await direnv.calls()).toHaveLength(1)

    await new Promise(resolve => setTimeout(resolve, 1_100))
    await runCommand(executor, { command: 'true', workdir: project })
    expect(await direnv.calls()).toHaveLength(2)
  })

  it('caches an absent .envrc per directory', async () => {
    const root = await makeRoot()
    const project = join(root, 'plain')
    await mkdir(project, { recursive: true })
    const { executor } = await mount()

    await runCommand(executor, { command: 'true', workdir: project })
    await runCommand(executor, { command: 'true', workdir: project })
    expect(executor.cacheEntries).toBe(1)
  })

  it('clears the cache when the plugin fiber is disposed', async () => {
    const root = await makeRoot()
    const project = await makeProject(root)
    const direnv = await installFakeDirenv(root, { stdout: '{}' })
    withFakeDirenvOnPath(direnv.binDir)
    const { executor, ctx } = await mount()

    await runCommand(executor, { command: 'true', workdir: project })
    expect(executor.cacheEntries).toBe(1)

    await ctx.fiber.dispose()
    expect(executor.cacheEntries).toBe(0)
  })
})

describe('composition registration', () => {
  it('refuses a second shell executor in the same composition', async () => {
    const root = await makeRoot()
    await makeProject(root)
    const { ctx } = await mount()

    await expect(ctx.plugin(SandboxBashExecutor, { graceMs: 200 })).rejects.toThrow()
  })
})
