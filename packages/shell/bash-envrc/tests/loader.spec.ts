/**
 * REAL-composition tier (packages/AGENTS.md): boot the package's Loader
 * fixture through the same app boot path a deployment uses and run one real
 * `bash` tool call. The fixture's fake `direnv` exports both project variables
 * and names the deny list must drop, so the spec asserts the positive
 * environment and every negative injection in the same child process.
 */

import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

/** What the driver persisted after one tool call. */
interface LoaderReport {
  /** Constructor name of the mounted `ctx.shell` implementation. */
  readonly executor: string
  /** Model-visible text of the bash tool result. */
  readonly text: string
  /** Recorded fake-`direnv` invocations. */
  readonly calls: readonly string[]
}

describe('bash-envrc through a real Loader composition', () => {
  it('runs a bash tool call with the project environment and without denied names', async () => {
    let report: LoaderReport | undefined
    let project: string | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'bash-envrc loader smoke',
      tempDirPrefix: 'bash-envrc-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'bash-envrc-report.json'), 'utf8')) as LoaderReport
        project = await realpath(cwd)
      },
    })

    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report?.executor).toBe('EnvrcBashExecutor')
    expect(report?.text).toBe([
      'value=from-envrc',
      'bash_env=<unset>',
      'path_marker=no',
      'ld_preload=<unset>',
      'dsh_session=<unset>',
      '',
    ].join('\n'))
    expect(report?.calls).toEqual([`${project ?? ''}|export json`])
  }, 45_000)
})
