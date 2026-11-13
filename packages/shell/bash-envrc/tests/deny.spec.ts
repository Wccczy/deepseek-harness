/**
 * Denial and selection rules, plus the drift check that keeps the copied
 * bootstrap lists equal to app-boot's private constants.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_DENY_NAMES, BOOTSTRAP_DENY_PREFIXES, selectEnvironment } from '../src/deny.ts'

const baseline: NodeJS.ProcessEnv = { PRESENT: 'same', OTHER: 'ambient' }

/** Select with empty allow/deny by default. */
function select(
  entries: Array<[string, string]>,
  extra: { allow?: string[]; deny?: string[] } = {},
): Record<string, string> {
  return selectEnvironment(entries, {
    allow: extra.allow ?? [],
    deny: extra.deny ?? [],
    baseline,
  })
}

describe('selectEnvironment', () => {
  it('forwards every non-denied entry when allow is empty', () => {
    const selected = select([
      ['PROJECT_VAR', 'a'],
      ['GH_CONFIG_DIR', '/accounts/work'],
      ['GOPATH', '/go'],
      ['JAVA_HOME', '/jdk'],
      ['NODE_EXTRA_CA_CERTS', '/ca.pem'],
    ])
    expect(selected).toEqual({ PROJECT_VAR: 'a', GH_CONFIG_DIR: '/accounts/work', GOPATH: '/go', JAVA_HOME: '/jdk' })
  })

  it('narrows to the allow list', () => {
    const selected = select([['GH_CONFIG_DIR', '/accounts/work'], ['GOPATH', '/go']], { allow: ['GH_CONFIG_DIR'] })
    expect(selected).toEqual({ GH_CONFIG_DIR: '/accounts/work' })
  })

  it('compares allow and deny names case-insensitively', () => {
    expect(select([['gh_config_dir', '/x']], { allow: ['GH_CONFIG_DIR'] })).toEqual({ gh_config_dir: '/x' })
    expect(select([['project_var', 'x']], { deny: ['PROJECT_VAR'] })).toEqual({})
  })

  it('refuses bootstrap names, managed prefixes, and credentials even when allowed', () => {
    const selected = select([
      ['PATH', '/evil'],
      ['BASH_ENV', '/evil'],
      ['DSH_SESSION_ID', 'forged'],
      ['XDG_CONFIG_HOME', '/evil'],
      ['DYLD_INSERT_LIBRARIES', '/evil'],
      ['BASH_FUNC_x', 'forged'],
      ['DIRENV_DIFF', 'stale'],
      ['MY_API_KEY', 'secret'],
      ['DB_PASSWORD', 'secret'],
      ['CLIENT_SECRET', 'secret'],
      ['ACCESS_TOKEN', 'secret'],
      ['SAFE_VALUE', 'ok'],
    ], { allow: ['PATH', 'BASH_ENV', 'DSH_SESSION_ID', 'MY_API_KEY', 'SAFE_VALUE'] })
    expect(selected).toEqual({ SAFE_VALUE: 'ok' })
  })

  it('applies the configured deny list on top of the built-in one', () => {
    expect(select([['PROJECT_VAR', 'x'], ['OTHER_VAR', 'y']], { deny: ['PROJECT_VAR'] }))
      .toEqual({ OTHER_VAR: 'y' })
  })

  it('drops a value the command would already inherit', () => {
    expect(select([['PRESENT', 'same'], ['OTHER', 'changed'], ['NEW', 'value']]))
      .toEqual({ OTHER: 'changed', NEW: 'value' })
  })
})

const appBootSource = fileURLToPath(new URL('../../../boot/app-boot/src/index.ts', import.meta.url))

/**
 * Read one private string collection from app-boot's source. The constants are
 * module-private by design, so the copy is compared against the source text
 * rather than forcing a public export on that package.
 * @param source - app-boot entry source.
 * @param declaration - the constant name to read.
 * @param terminator - source text that closes the declaration.
 * @returns the quoted names in declaration order.
 */
function readAppBootList(source: string, declaration: string, terminator: string): string[] {
  const start = source.indexOf(`const ${declaration} = `)
  expect(start, `${declaration} must exist in app-boot`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(terminator, start)
  expect(end, `${declaration} must close with ${terminator}`).toBeGreaterThan(start)
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)]
    .flatMap(match => match[1] === undefined ? [] : [match[1]])
}

describe('bootstrap deny list drift', () => {
  it('matches app-boot BOOTSTRAP_NAMES and BOOTSTRAP_PREFIXES exactly', async () => {
    const source = await readFile(appBootSource, 'utf8')
    expect(BOOTSTRAP_DENY_NAMES).toEqual(readAppBootList(source, 'BOOTSTRAP_NAMES', '])'))
    expect(BOOTSTRAP_DENY_PREFIXES).toEqual(readAppBootList(source, 'BOOTSTRAP_PREFIXES', ']'))
    expect(BOOTSTRAP_DENY_NAMES.length).toBeGreaterThan(0)
    expect(BOOTSTRAP_DENY_PREFIXES.length).toBeGreaterThan(0)
  })
})
