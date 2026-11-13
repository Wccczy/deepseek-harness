/**
 * Collected-output access for the resolution command. The executor always
 * requests both streams in collect mode, so a missing reader means the
 * provider abandoned the requested dispositions and the export cannot be
 * trusted.
 * @module @deepseek-ai/dsh-bash-envrc/subprocess
 */

import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { EnvrcError } from './errors.ts'

/** The two collected readers one resolution depends on. */
export interface CollectedReaders {
  /** Captured stdout, which must parse as direnv's JSON object. */
  readonly stdout: SubprocessOutputReader
  /** Captured stderr, used only in failure messages. */
  readonly stderr: SubprocessOutputReader
}

/**
 * Read the collected streams from a handle spawned with both streams in
 * collect mode.
 * @param handle - the live handle.
 * @param label - program name for the diagnostic.
 * @returns both readers.
 * @throws EnvrcError with `ENVRC_OUTPUT` when a requested reader is absent.
 */
export function collectReaders(handle: SubprocessHandle, label: string): CollectedReaders {
  const { stdout, stderr } = handle.collected
  if (stdout === undefined || stderr === undefined) {
    throw new EnvrcError('ENVRC_OUTPUT', `bash-envrc: ${label} returned no captured output streams`)
  }
  return { stdout, stderr }
}
