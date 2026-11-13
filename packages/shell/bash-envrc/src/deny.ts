/**
 * Names a project `.envrc` may never contribute to a shell command. The
 * bootstrap lists are copied from `packages/boot/app-boot/src/index.ts`
 * (`BOOTSTRAP_NAMES` / `BOOTSTRAP_PREFIXES`); `tests/deny-drift.spec.ts` reads
 * that file and fails when the two copies diverge.
 * @module @deepseek-ai/dsh-bash-envrc/deny
 */

/**
 * Exact names no project file may set: process launch, module resolution,
 * interpreter startup hooks, version-control hooks and ambient command
 * selectors, and network reach or trust. Copy of app-boot's private
 * `BOOTSTRAP_NAMES`.
 */
export const BOOTSTRAP_DENY_NAMES: readonly string[] = [
  // Process launch and module resolution.
  'PATH', 'HOME', 'USERPROFILE', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  // Interpreter startup hooks.
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  'PERL5OPT', 'PERL5LIB', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'PYTHONHOME',
  // Version-control hooks, config redirects, and ambient command selectors.
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR',
  'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  // Network reach and trust.
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
]

/** Name prefixes no project file may set. Copy of app-boot's private `BOOTSTRAP_PREFIXES`. */
export const BOOTSTRAP_DENY_PREFIXES: readonly string[] = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']

/**
 * `direnv`'s own bookkeeping (`DIRENV_DIFF`, `DIRENV_DIR`, `DIRENV_FILE`,
 * `DIRENV_WATCHES`, …). They describe the resolution invocation, not the
 * project, and a forwarded `DIRENV_*` set would make a nested `direnv` treat
 * the command shell as already loaded.
 */
export const DIRENV_DENY_PREFIX = 'DIRENV_'

/**
 * Names whose value is a credential. A project file may not forward one: the
 * subprocess service scrubs the same names from the ambient environment, and
 * `envrc.allow` cannot re-admit them.
 */
export const SECRET_NAME_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Whether one candidate name is excluded before the `envrc.allow` narrowing. */
function isDeniedName(name: string, deny: ReadonlySet<string>): boolean {
  const upper = name.toUpperCase()
  return deny.has(upper)
    || BOOTSTRAP_DENY_PREFIXES.some(prefix => upper.startsWith(prefix))
    || upper.startsWith(DIRENV_DENY_PREFIX)
    || SECRET_NAME_PATTERN.test(name)
}

/** Options for {@link selectEnvironment}. */
export interface EnvironmentSelection {
  /** When non-empty, only these names pass; compared case-insensitively. */
  readonly allow: readonly string[]
  /** Extra names denied on top of the built-in lists; compared case-insensitively. */
  readonly deny: readonly string[]
  /** Ambient environment the command would otherwise inherit. */
  readonly baseline: NodeJS.ProcessEnv
}

/**
 * Narrow a `direnv export json` result to the entries this executor may
 * forward. Denial runs first (bootstrap names and prefixes, `DIRENV_*`,
 * credential-shaped names, and the extra `deny` list), then the optional
 * `allow` whitelist, then the second difference against `baseline`: a value
 * the command would already inherit is dropped so the caller's environment is
 * never overwritten wholesale.
 * @param candidates - entries parsed from the export output.
 * @param selection - allow/deny configuration and the ambient baseline.
 * @returns the entries to merge beneath the caller's explicit `env`.
 */
export function selectEnvironment(
  candidates: Iterable<readonly [string, string]>,
  selection: EnvironmentSelection,
): Record<string, string> {
  const deny = new Set([
    ...BOOTSTRAP_DENY_NAMES.map(name => name.toUpperCase()),
    ...selection.deny.map(name => name.toUpperCase()),
  ])
  const allow = selection.allow.length === 0
    ? undefined
    : new Set(selection.allow.map(name => name.toUpperCase()))
  const selected: Record<string, string> = {}
  for (const [name, value] of candidates) {
    if (isDeniedName(name, deny)) continue
    if (allow !== undefined && !allow.has(name.toUpperCase())) continue
    if (selection.baseline[name] === value) continue
    selected[name] = value
  }
  return selected
}
