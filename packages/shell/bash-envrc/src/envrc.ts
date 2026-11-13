/**
 * Project `.envrc` discovery, `direnv export json` parsing, and the bounded
 * per-directory result cache. Discovery follows direnv: the nearest `.envrc`
 * above the real working directory wins.
 * @module @deepseek-ai/dsh-bash-envrc/envrc
 */

import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EnvrcError } from './errors.ts'

/** File name direnv reads in a project directory. */
export const ENVRC_FILE = '.envrc'

/** One discovered `.envrc`, with the identity facts a cache key needs. */
export interface EnvrcLocation {
  /** Absolute path of the `.envrc`. */
  readonly file: string
  /** Directory holding the file; also the directory the refusal hint names. */
  readonly directory: string
  /** Modification time captured at discovery. */
  readonly mtimeMs: number
  /** File size captured at discovery. */
  readonly size: number
}

/** Whether an errno names an absent path or path component. */
function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Resolve a working directory to its real path. A path that cannot be
 * resolved yields no project environment: the command's own executor reports
 * the unusable directory, so this step never masks it with a different error.
 * @param workdir - absolute working directory from the resolved spec.
 * @returns the canonical directory, or undefined when it cannot be resolved.
 */
export async function realDirectoryOf(workdir: string): Promise<string | undefined> {
  try {
    return await realpath(workdir)
  } catch {
    return undefined
  }
}

/**
 * Find the nearest `.envrc` at or above a real working directory, walking
 * upward to the filesystem root. The directory is expected to be canonical.
 * @param workdir - canonical working directory.
 * @returns the discovered location, or undefined when no `.envrc` exists.
 */
export async function findEnvrc(workdir: string): Promise<EnvrcLocation | undefined> {
  let directory = workdir
  for (;;) {
    const file = join(directory, ENVRC_FILE)
    try {
      const information = await stat(file)
      return { file, directory, mtimeMs: information.mtimeMs, size: information.size }
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Parse `direnv export json` output. Only string values become environment
 * entries; a `null` value is direnv's "unset" marker and carries nothing to
 * forward, while any other value type is malformed output.
 * @param text - captured stdout.
 * @returns the environment entries direnv exported.
 * @throws EnvrcError with `ENVRC_OUTPUT` when the text is not a JSON object.
 */
export function parseEnvrcExport(text: string): Record<string, string> {
  // An empty export is direnv's valid no-change result: when the command
  // environment already equals the project environment, it prints nothing.
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new EnvrcError('ENVRC_OUTPUT', 'direnv export json printed unparseable output', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvrcError('ENVRC_OUTPUT', 'direnv export json must print a JSON object')
  }
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (value === null) continue
    if (typeof value !== 'string') {
      throw new EnvrcError('ENVRC_OUTPUT', `direnv export json printed a non-string value for ${name}`)
    }
    environment[name] = value
  }
  return environment
}

/**
 * Build the cache key for one resolution attempt: the canonical working
 * directory, plus the `.envrc` path and its mtime/size when one exists. Keying
 * on the file identity is what turns a changed `.envrc` into a miss.
 * @param workdir - canonical working directory.
 * @param location - discovered `.envrc`, absent when the directory has none.
 * @returns the cache key.
 */
export function envrcCacheKey(workdir: string, location: EnvrcLocation | undefined): string {
  if (location === undefined) return `${workdir}\u0000`
  return `${workdir}\u0000${location.file}\u0000${String(location.mtimeMs)}\u0000${String(location.size)}`
}

/** One cache entry; an undefined environment is the cached "no project file" result. */
export interface EnvrcCacheEntry {
  /** Environment entries resolved from the project file. */
  readonly environment: Readonly<Record<string, string>> | undefined
  /** Epoch milliseconds after which the entry must be discarded. */
  readonly expiresAt: number
}

/**
 * Time-bounded cache of resolved project environments, owned by one executor
 * instance so reloading the plugin starts from a clean cache. Only successful
 * and absent-file results are stored; refusals and failures are retried on the
 * next command.
 */
export class EnvrcCache {
  private readonly entries = new Map<string, EnvrcCacheEntry>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Read one entry, discarding an expired one.
   * @param key - key from {@link envrcCacheKey}.
   * @returns the live entry, or undefined on a miss.
   */
  get(key: string): EnvrcCacheEntry | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  /**
   * Store one resolved result until the configured TTL elapses.
   * @param key - key from {@link envrcCacheKey}.
   * @param environment - resolved entries, or undefined for "no project file".
   */
  set(key: string, environment: Readonly<Record<string, string>> | undefined): void {
    this.entries.set(key, { environment, expiresAt: Date.now() + this.ttlMs })
  }

  /** Drop every entry; called when the owning plugin fiber is disposed. */
  clear(): void {
    this.entries.clear()
  }

  /** Number of retained entries, for lifecycle assertions. */
  get size(): number {
    return this.entries.size
  }
}
