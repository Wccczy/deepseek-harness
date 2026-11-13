#!/usr/bin/env node
/**
 * Test driver: prepare a project directory and a fake `direnv`, boot the
 * Loader composition through the real app boot path, execute one real `bash`
 * tool call, and persist the observed model-visible output plus the resolved
 * executor name to `./bash-envrc-report.json` for the package spec.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('bash-envrc driver requires a config path')

const project = process.cwd()
const binDir = join(project, 'fake-bin')
const exportFile = join(project, 'direnv-export.json')
const callLog = join(project, 'direnv-calls.log')

await mkdir(binDir, { recursive: true })
await writeFile(join(project, '.envrc'), 'export PROJECT_VAR=from-envrc\n')
await writeFile(exportFile, JSON.stringify({
  PROJECT_VAR: 'from-envrc',
  PATH: '/envrc-injected/bin',
  BASH_ENV: '/envrc-injected/env',
  LD_PRELOAD: '/envrc-injected/lib.so',
  DSH_SESSION_ID: 'forged',
  GH_TOKEN: 'secret',
}))
const direnv = join(binDir, 'direnv')
await writeFile(direnv, `#!/bin/sh\nprintf '%s\\n' "$PWD|$*" >> '${callLog}'\nexec cat '${exportFile}'\n`)
await chmod(direnv, 0o755)
process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`

const ctx = await boot('bash-envrc-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('loader-bash-envrc'),
    name: 'bash',
    arguments: {
      command: [
        'printf \'value=%s\\n\' "$PROJECT_VAR"',
        'printf \'bash_env=%s\\n\' "${BASH_ENV-<unset>}"',
        'case "$PATH" in *envrc-injected*) printf \'path_marker=yes\\n\' ;; *) printf \'path_marker=no\\n\' ;; esac',
        'printf \'ld_preload=%s\\n\' "${LD_PRELOAD-<unset>}"',
        'printf \'dsh_session=%s\\n\' "${DSH_SESSION_ID-<unset>}"',
      ].join('\n'),
      description: 'loader environment probe',
      workdir: project,
    },
  })
  const text = result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  await writeFile(join(project, 'bash-envrc-report.json'), JSON.stringify({
    executor: ctx.shell.constructor.name,
    text,
    calls: (await readFile(callLog, 'utf8').catch(() => '')).split('\n').filter(line => line !== ''),
  }))
} finally {
  await ctx.fiber.dispose()
}
