/**
 * Registers the GitHub provider of `ctx.forge`, which reads pull requests through the GitHub CLI on the host, and, while
 * forge-session runs, the `gh` commands that bind pull requests to a Session.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import type {} from '@deepseek-ai/dsh-experimental-forge-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { GH_COMMANDS } from './commands.ts'
import { ghRunner } from './gh.ts'
import { GitHubProvider, type AccountRoute } from './provider.ts'

export const name = 'forge-github'
export const inject = ['forge']

export type { AccountRoute } from './provider.ts'

/** GitHub CLI executable, served hosts, and invocation limits. */
export interface Config {
  /** GitHub CLI executable name or absolute host path. */
  ghCommand?: string
  /** Host names this provider serves; list GitHub Enterprise hosts explicitly. */
  hosts?: string[]
  /** Deadline in milliseconds for one `gh` invocation. */
  timeoutMs?: number
  /** Maximum captured bytes per `gh` output stream and combined JSON bytes of one complete check read or review read. */
  maxOutputBytes?: number
  /**
   * Most review threads counted per pull request in one status read, which reports a lower bound past it, and read in
   * one review read, which reports itself truncated past it.
   */
  maxReviewThreads?: number
  /**
   * Most pull requests one snapshot query reads. The forge registry polls that many pull requests of a host per call,
   * each call within its own fetch deadline; a read of more pull requests on one host sends several queries in turn.
   */
  snapshotBatchSize?: number
  /** The same bound for one brief query. */
  briefBatchSize?: number
  /** Most commits one pull request commit listing returns; GitHub lists at most 250 commits of a pull request. */
  maxCommits?: number
  /** Most files whose viewed marks one read lists; GitHub lists at most 3,000 files of a pull request. */
  maxViewedFiles?: number
  /** Most pull requests one viewer list read returns, at most 100, the size of one GitHub search page. */
  maxViewerItems?: number
  /**
   * `gh` accounts of one owner's repositories. A route whose `owner` equals the repository owner without case, and
   * whose `host`, when given, equals the repository host without case, selects the `GH_CONFIG_DIR` of every call about
   * that repository; an exact host match wins over a route without `host`, which applies to every configured host. A
   * repository no route matches keeps the inherited environment.
   */
  accounts?: AccountRoute[]
}

export const Config: z<Config> = z.object({
  ghCommand: z.string().default('gh'),
  hosts: z.array(z.string()).default(['github.com']),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
  maxReviewThreads: z.number().default(1_000),
  snapshotBatchSize: z.number().default(8),
  briefBatchSize: z.number().default(25),
  maxCommits: z.number().default(250),
  maxViewedFiles: z.number().default(3_000),
  maxViewerItems: z.number().default(50),
  accounts: z.array(z.object({
    owner: z.string().required(),
    host: z.string(),
    ghConfigDir: z.string().required(),
  })).default([]),
})

/** Most results one GitHub search page returns. */
const SEARCH_PAGE = 100

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

/** Characters GitHub permits in an owner name. */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.ghCommand.trim().length === 0) throw new Error('forge-github: ghCommand must not be empty')
  if (resolved.hosts.length === 0) throw new Error('forge-github: hosts must list at least one host')
  for (const host of resolved.hosts) {
    if (!HOST.test(host)) throw new Error(`forge-github: invalid host ${JSON.stringify(host)}`)
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`forge-github: timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const key of [
    'maxOutputBytes', 'maxReviewThreads', 'snapshotBatchSize', 'briefBatchSize', 'maxCommits', 'maxViewedFiles', 'maxViewerItems',
  ] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-github: ${key} must be a positive safe integer`)
  }
  if (resolved.maxViewerItems > SEARCH_PAGE) throw new Error(`forge-github: maxViewerItems must be no greater than ${SEARCH_PAGE}`)
  const routed = new Set<string>()
  for (const { owner, host, ghConfigDir } of resolved.accounts) {
    if (!OWNER.test(owner)) throw new Error(`forge-github: invalid account owner ${JSON.stringify(owner)}`)
    if (ghConfigDir.trim().length === 0) throw new Error(`forge-github: account for ${JSON.stringify(owner)} must set a ghConfigDir`)
    if (host !== undefined && !resolved.hosts.some(served => served.toLowerCase() === host.toLowerCase())) {
      throw new Error(`forge-github: account for ${JSON.stringify(owner)} names host ${JSON.stringify(host)}, which is not in hosts`)
    }
    const effective = `${owner.toLowerCase()}\n${host === undefined ? '' : host.toLowerCase()}`
    if (routed.has(effective)) {
      throw new Error(`forge-github: duplicate account for ${JSON.stringify(owner)}${host === undefined ? '' : ` on host ${JSON.stringify(host)}`}`)
    }
    routed.add(effective)
  }
  ctx.forge.register(new GitHubProvider(ghRunner(resolved), resolved.hosts, resolved, resolved.accounts))
  ctx.inject(['forgeSession'], (scope) => {
    scope.forgeSession.registerCommands(GH_COMMANDS)
  })
}
