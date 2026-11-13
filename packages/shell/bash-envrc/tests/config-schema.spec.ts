/**
 * Configuration surface: the repeated parent fields must stay identical to
 * `dsh-bash-local`'s, and the project-environment defaults are part of the
 * published contract.
 */

import { describe, expect, it } from 'vitest'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { EnvrcBashExecutor } from '../src/index.ts'

const PARENT_FIELDS = ['cwd', 'timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs'] as const

describe('configuration schema', () => {
  it('repeats every parent field with the parent type and metadata', () => {
    const parent = LocalBashExecutor.Config.dict
    const ours = EnvrcBashExecutor.Config.dict
    for (const field of PARENT_FIELDS) {
      const parentField = parent?.[field]
      const ourField = ours?.[field]
      expect(ourField, `${field} must exist`).toBeDefined()
      expect(ourField?.type, field).toBe(parentField?.type)
      expect(ourField?.meta, field).toEqual(parentField?.meta)
    }
  })

  it('fills the documented project-environment defaults', () => {
    expect(EnvrcBashExecutor.Config({}).envrc).toEqual({
      enabled: true,
      command: ['direnv', 'export', 'json'],
      timeoutMs: 10_000,
      allow: [],
      deny: [],
      failOnRefusal: true,
      cacheMs: 30_000,
    })
  })

  it('rejects an empty command, a zero deadline, and a negative cache ttl', () => {
    expect(() => EnvrcBashExecutor.Config({ envrc: { command: [] } })).toThrow()
    expect(() => EnvrcBashExecutor.Config({ envrc: { timeoutMs: 0 } })).toThrow()
    expect(() => EnvrcBashExecutor.Config({ envrc: { cacheMs: -1 } })).toThrow()
  })
})
