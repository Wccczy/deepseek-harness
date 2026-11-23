/** Per-repository `gh` account routing: which calls carry a `GH_CONFIG_DIR`, and which validation rejects a route. */
import { Context } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import type { ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'
import { afterEach, describe, expect, it } from 'vitest'
import type { GhOutput } from '../src/gh.ts'
import * as ForgeGitHub from '../src/index.ts'
import { GitHubProvider } from '../src/provider.ts'
import type { AccountRoute, GitHubLimits } from '../src/provider.ts'
import { demo, pull, pullRequestNode, recordingGh } from './fixtures.ts'

const signal = new AbortController().signal
const HEAD = 'f'.repeat(40)
const enterprise: ForgeRepository = { forge: 'github', host: 'ghe.corp.example', owner: 'team', name: 'svc' }
const limits: GitHubLimits = {
  maxOutputBytes: 8_388_608, maxReviewThreads: 1_000, snapshotBatchSize: 8, briefBatchSize: 50,
  maxCommits: 250, maxViewedFiles: 3_000, maxViewerItems: 50,
}

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

function provider(accounts: readonly AccountRoute[], answer: GhOutput = output({ data: { r0: { p0: pullRequestNode(1) } } })) {
  const gh = recordingGh(() => answer)
  return { gh, subject: new GitHubProvider(gh.run, ['github.com', 'ghe.corp.example'], limits, accounts) }
}

describe('account routes', () => {
  it('reads one owner’s repositories under its account and leaves the others on the inherited one', async () => {
    const routed = provider([{ owner: 'octo', ghConfigDir: '/accounts/octo' }])

    await routed.subject.fetch([pull(1)], signal)
    await routed.subject.fetch([pull(1, { ...demo, owner: 'other' })], signal)

    expect(routed.gh.calls.map(call => call.call)).toEqual([{ ghConfigDir: '/accounts/octo' }, undefined])
  })

  it('splits the pull requests of one host by account, so no query reads one repository under another’s account', async () => {
    const routed = provider([{ owner: 'octo', ghConfigDir: '/accounts/octo' }])

    await routed.subject.fetch([pull(1), pull(2, { ...demo, owner: 'other' })], signal)

    expect(routed.gh.calls.map(call => call.call)).toEqual([{ ghConfigDir: '/accounts/octo' }, undefined])
    expect(routed.gh.calls[0]?.args.join(' ')).toContain('pullRequest(number: 1)')
    expect(routed.gh.calls[0]?.args.join(' ')).not.toContain('pullRequest(number: 2)')
  })

  it('matches the owner and the host without case', async () => {
    const routed = provider([{ owner: 'OCTO', ghConfigDir: '/accounts/octo' }, { owner: 'Team', host: 'GHE.Corp.Example', ghConfigDir: '/accounts/team' }])

    await routed.subject.fetch([pull(1)], signal)
    await routed.subject.fetch([pull(2, enterprise)], signal)

    expect(routed.gh.calls.map(call => call.call)).toEqual([{ ghConfigDir: '/accounts/octo' }, { ghConfigDir: '/accounts/team' }])
  })

  it('prefers a route that names the host over one that applies to every host', async () => {
    const routed = provider([
      { owner: 'team', ghConfigDir: '/accounts/team-default' },
      { owner: 'team', host: 'ghe.corp.example', ghConfigDir: '/accounts/team-enterprise' },
    ])

    await routed.subject.fetch([pull(1, enterprise)], signal)
    await routed.subject.fetch([pull(2, { ...demo, owner: 'team' })], signal)

    expect(routed.gh.calls.map(call => call.call)).toEqual([
      { ghConfigDir: '/accounts/team-enterprise' }, { ghConfigDir: '/accounts/team-default' },
    ])
  })

  it('leaves the environment untouched when no route matches', async () => {
    const routed = provider([{ owner: 'team', host: 'ghe.corp.example', ghConfigDir: '/accounts/team' }])

    await routed.subject.fetch([pull(1)], signal)

    expect(routed.gh.calls[0]?.call).toBeUndefined()
  })

  it('carries the account on a repository-scoped write', async () => {
    const gh = recordingGh(args => args.includes('--input')
      ? output({ data: { updatePullRequestBranch: { clientMutationId: null } } })
      : output({ data: { repository: { pullRequest: { id: 'PR_1', headRefOid: HEAD } } } }))
    const subject = new GitHubProvider(gh.run, ['github.com'], limits, [{ owner: 'octo', ghConfigDir: '/accounts/octo' }])

    await expect(subject.updateBranch(pull(1), { method: 'merge', headSha: HEAD }, signal)).resolves.toBeUndefined()
    expect(gh.calls.map(call => call.call?.ghConfigDir)).toEqual(['/accounts/octo', '/accounts/octo'])
    expect(gh.calls[1]?.call?.input).toContain('updatePullRequestBranch')
  })

  it('keeps the sign-in probe, the viewer lists, and the viewer counts on the process account', async () => {
    const gh = recordingGh((args) => {
      if (args[0] === 'auth') return { exitCode: 0, stdout: '', stderr: '' }
      if (args.some(arg => arg.startsWith('review='))) {
        return output({ data: { review: { issueCount: 1 }, authored: { issueCount: 2 }, involved: { issueCount: 3 } } })
      }
      if (args.some(arg => arg.startsWith('q='))) return output({ data: { viewer: { login: 'octo' }, search: { issueCount: 0, nodes: [] } } })
      return output({ data: { r0: { p0: pullRequestNode(1) } } })
    })
    const subject = new GitHubProvider(gh.run, ['github.com'], limits, [{ owner: 'octo', ghConfigDir: '/accounts/octo' }])

    await subject.readiness('github.com', signal)
    await subject.listForViewer({ host: 'github.com', filter: 'authored', repository: null, limit: 10 }, signal)
    await subject.countForViewer('github.com', signal)
    await subject.fetch([pull(1)], signal)

    expect(gh.calls.map(call => call.call)).toEqual([undefined, undefined, undefined, { ghConfigDir: '/accounts/octo' }])
  })
})

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function forge(): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(ForgeService)
  return ctx
}

describe('account route validation', () => {
  it.each([
    [[{ owner: 'octo!', ghConfigDir: '/accounts/octo' }], 'forge-github: invalid account owner "octo!"'],
    [[{ owner: '-octo', ghConfigDir: '/accounts/octo' }], 'forge-github: invalid account owner "-octo"'],
    [[{ owner: '', ghConfigDir: '/accounts/octo' }], 'forge-github: invalid account owner ""'],
    [[{ owner: 'octo', ghConfigDir: '   ' }], 'forge-github: account for "octo" must set a ghConfigDir'],
    [[{ owner: 'octo', host: 'ghe.corp.example', ghConfigDir: '/accounts/octo' }],
      'forge-github: account for "octo" names host "ghe.corp.example", which is not in hosts'],
    [[{ owner: 'octo', host: 'github.com', ghConfigDir: '/a' }, { owner: 'OCTO', host: 'GitHub.com', ghConfigDir: '/b' }],
      'forge-github: duplicate account for "OCTO" on host "GitHub.com"'],
    [[{ owner: 'octo', ghConfigDir: '/a' }, { owner: 'OCTO', ghConfigDir: '/b' }], 'forge-github: duplicate account for "OCTO"'],
  ])('rejects %j at load', async (accounts, message) => {
    const context = await forge()

    await expect(context.plugin(ForgeGitHub, { accounts })).rejects.toThrow(message)
  })

  it('serves a host the route names, whatever its case', async () => {
    const context = await forge()

    await context.plugin(ForgeGitHub, { hosts: ['github.com', 'ghe.corp.example'], accounts: [{ owner: 'team', host: 'GHE.Corp.Example', ghConfigDir: '/accounts/team' }] })

    expect(context.forge.repositoryFromRemote('https://ghe.corp.example/team/svc.git')).toEqual(enterprise)
  })
})
