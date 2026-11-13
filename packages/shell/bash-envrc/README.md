---
description: "The Bash executor that loads each project's .envrc environment through direnv export json, for deployments that keep per-project toolchains, language runtimes, and tool accounts in direnv."
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-envrc

English | [中文](README.zh.md)

## Summary

Use `dsh-bash-envrc` when every project directory defines its own environment in `.envrc` and the model's bash commands must see it. The executor replaces `dsh-bash-sandbox` and keeps the sandbox executor's mechanics: commands are still confined by the same per-call policy, deadlines and background jobs are unchanged, and the model-facing `bash` tool is untouched. Before each command it asks `direnv export json` for the working directory's project environment, keeps only the entries the command would not already inherit, refuses every name a project file must not control, and merges the rest beneath the caller's explicit environment map.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to choose it

Choose it in place of `dsh-bash-sandbox` when the same machine hosts several projects or worktrees that need different toolchains, language runtimes, or tool accounts, and each of them already describes that environment in an `.envrc`. The executor is generic: it forwards whatever direnv exports after filtering, so the `.envrc` decides which variables exist and this package never names a vendor, tool, or account of its own. For deployments without `.envrc` files, mount `dsh-bash-sandbox` directly; this executor then resolves nothing and adds the ambient-environment pass-through of a directory without a project file.

### How a command environment is resolved

Resolution happens per command, because the model chooses `workdir` and may cross projects or worktrees between calls.

1. The resolved `workdir` is canonicalized with `realpath`, matching direnv's own path handling.
2. The nearest `.envrc` at or above that directory is located by walking upward; direnv loads only that one file unless the file asks for more. No `.envrc` means the command runs exactly as it would on the parent executor, with no subprocess and no environment change.
3. `envrc.command` (default `['direnv', 'export', 'json']`) runs in the working directory under its own deadline and output bound, through `ctx.subprocess`, with inherited `DIRENV_*` bookkeeping removed so a harness started inside a direnv shell still resolves the target directory. Its JSON object supplies candidate entries; a `null` value is direnv's unset marker and carries nothing, and an empty export (the command environment already matches) contributes no entries.
4. Candidates are filtered (below) and then compared one more time against the harness process environment: an entry whose value the command would already inherit is dropped, so the project file never replaces `PATH`, `HOME`, or any other inherited value wholesale.
5. The surviving entries merge as `{ ...resolved, ...spec.env }`: the project environment stays beneath a caller's explicit `env`, and the managed `dshEnv` snapshot still merges last inside the executor.

A successful result and an absent project file are cached per working directory for `envrc.cacheMs`, keyed by the canonical directory, the `.envrc` path, and its modification time and size. Changing the `.envrc` file invalidates the entry immediately; failures are never cached, so a refused or timed-out resolution is retried on the next command.

### Which variables are refused

The refusal lists run before `envrc.allow`, so an allow entry can never re-admit a refused name. The bootstrap names and prefixes are a copy of the application-boot guard that decides which variables a discovered `.env` file may set ([source](../../boot/app-boot/src/index.ts)); a test reads that file and fails when the copy drifts.

| Refused | Examples |
|---|---|
| Bootstrap names (process launch, module resolution, interpreter hooks, VCS hooks, network trust) | `PATH`, `HOME`, `BASH_ENV`, `NODE_OPTIONS`, `LD_PRELOAD`, `GIT_SSH_COMMAND`, `SSL_CERT_FILE`, `HTTP_PROXY` |
| Bootstrap prefixes | `DSH_`, `XDG_`, `DYLD_`, `BASH_FUNC_` |
| direnv's own bookkeeping | `DIRENV_DIFF`, `DIRENV_DIR`, `DIRENV_FILE`, `DIRENV_WATCHES` |
| Credential-shaped names | Any name matching `KEY`, `PASSWORD`, `SECRET`, or `TOKEN` in any letter case |
| Configured `envrc.deny` entries | Any name the deployment adds |

`envrc.allow` is a narrowing switch, not the default form. Left empty, every exported entry that is not refused above passes; that is the intended shape for projects that need several variables at once, such as a per-project `GOPATH`, `JAVA_HOME`, `GOROOT`, `GEM_HOME`, or `GH_CONFIG_DIR`. Set it only when the project environment must be restricted to a known list:

```yaml
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-envrc'
  config:
    envrc:
      # Empty (the default) forwards every entry except the refused names above.
      # allow: [GH_CONFIG_DIR]
      # Do NOT set allow when several variables must pass: a non-empty allow
      # keeps only the listed names, so GOPATH, JAVA_HOME, and friends would
      # be dropped even though they are not refused.
      allow: []
```

Bootstrap-only names stay refused even with an empty allow: for example `NODE_EXTRA_CA_CERTS` belongs to the application-boot network-trust list, so a project file cannot install a CA bundle into model shell commands. A deployment that needs one sets it in the Harness home environment instead.

### Configuration

The fields extend the local executor's own configuration (`cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`), which keeps its defaults; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-bash-envrc) is the exhaustive source.

| Field | Default | Meaning |
|---|---|---|
| `envrc.enabled` | `true` | Resolve the project environment at all; false behaves exactly like the parent executor. |
| `envrc.command` | `['direnv', 'export', 'json']` | Command that prints the JSON export; argv, never shell-interpreted. |
| `envrc.timeoutMs` | `10000` | Deadline for one resolution, independent of the command's own timeout. |
| `envrc.allow` | `[]` | When non-empty, the only names that may pass; compared case-insensitively. |
| `envrc.deny` | `[]` | Extra refused names on top of the built-in lists; compared case-insensitively. |
| `envrc.failOnRefusal` | `true` | Fail the command when direnv refuses the `.envrc`; false logs and runs with the ambient environment. |
| `envrc.cacheMs` | `30000` | How long a resolved environment and an absent `.envrc` stay cached. |

### Failures

A silent fallback would reproduce the defect this executor exists to fix, so every failure except a configured downgrade is loud and carries a stable code that the tool result keeps.

| Code | Cause | Behavior |
|---|---|---|
| `ENVRC_REFUSED` | The configured command exited `1`, normally an unapproved `.envrc` | Fails the tool call; the message names the directory and asks for `direnv allow <dir>`. With `failOnRefusal: false`, the command runs with the ambient environment and the plugin logs the refusal instead. |
| `ENVRC_UNAVAILABLE` | The executable could not be started | Fails the tool call; the message says to install direnv or change `envrc.command`. |
| `ENVRC_TIMEOUT` | The resolution outlived `envrc.timeoutMs` | Fails the tool call; the command never runs. |
| `ENVRC_OUTPUT` | Output exceeded the bound, was not JSON, or the provider returned no captured streams | Fails the tool call. |
| `ENVRC_FAILED` | Any other start failure or non-zero exit status | Fails the tool call; the message includes the exit status and captured stderr. |

### Enable it in a profile

The base bundle occupies `ctx.shell` with `- id: bash-sandbox` ([base bundle](../../bundle/base/cordis.patch.yml)), and only one executor may be mounted: a second registration fails at load time. A patch's `name` selects the entry it targets; it cannot rename that entry, and a mismatched name is skipped with a warning. Replace the shipped executor by disabling its row and inserting this plugin under its own id, the same shape the PowerShell test lane uses ([example](../../../apps/web/tests/pwsh-terminal.overlay.yml)). Install the package into the profile's package set, then add this to the profile's `cordis.patch.yml`:

```yaml
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: true
- insert:
    - id: bash-envrc
      name: '@deepseek-ai/dsh-bash-envrc'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 60000
        envrc:
          enabled: true
          # Only forward a known list (for example a per-account tool directory):
          # allow: [GH_CONFIG_DIR]
          # To forward several variables, leave allow unset/empty and rely on the
          # built-in refusal lists.
```

On Windows the shipped composition mounts `pwsh-sandbox` and disables `bash-sandbox`; this executor inherits the Bash executor's POSIX contract and is not a replacement for the PowerShell slot.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package is one sandbox-executor subclass plus three helper modules. It never copies the executor's argv or lifecycle logic: `execute()` resolves the project environment, then calls `SandboxBashExecutor.execute()` with an environment-augmented spec, so sandbox confinement, deadlines, background handles, output collection, and spill files keep the exact semantics of the executor it replaces.

| Source | Responsibility |
|---|---|
| `src/index.ts` | `EnvrcBashExecutor`: config schema, per-command resolution, cache ownership, and the failure-to-tool-error mapping. |
| `src/envrc.ts` | `.envrc` discovery, export parsing, cache keys, and the TTL cache. |
| `src/deny.ts` | The copied bootstrap refusal lists, the `DIRENV_*` and credential rules, and the allow/deny/baseline selection. |
| `src/errors.ts` | `EnvrcError` and its stable codes. |
| `src/subprocess.ts` | Collected-stream access for the resolution command. |

The cache lives on the executor instance and clears when the plugin fiber is disposed, so a reload starts from a clean state and no module-level state survives a composition.

<a id="further-exploration"></a>
## Further Exploration

- [Shell executor subsystem](../../../docs/subsystems/shell.md) — the request/spec vocabulary and executor contract this plugin implements.
- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — the credential scrub and environment merge order every resolution and command inherits.
- [Shell package group](../README.md) — the other Bash and PowerShell executors and their tools.

## Model Experience

Indirectly, through `dsh-tool-bash`, which renders every command's output and keeps its schema unchanged; this executor only decides the environment each command starts with.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Only shell-executor calls see the project environment** — MCP servers, subagent CLIs, and PTC workers do not run through `ctx.shell`, so a project variable reaches them only when the deployment supplies it another way.
- **The `.envrc` runs with harness privileges** — resolution spawns direnv as a host process, so an approved `.envrc` executes outside the command's sandbox and can read whatever the harness process can read. direnv's own allow gate is the trust boundary; this plugin never runs `direnv allow`.
- **Ambient variables from the launching shell are not unloaded** — the executor forwards only what direnv exports for the command's directory and never removes an inherited variable, so a value exported by the shell that launched the harness stays visible in every command even when another project's `.envrc` does not set it.
- **A change to a file the `.envrc` sources is invisible until the cache expires** — the cache key covers the `.envrc` path, modification time, and size only; changes to included files take effect after `envrc.cacheMs`.
- **Resolution costs one subprocess per cache miss** — the first command in a directory waits for `direnv export json`; the default 10-second deadline bounds a slow or interactive `.envrc`.
- **No `direnv` daemon control or `direnv allow`** — the plugin uses the configured command as-is and leaves approval, block decisions, and daemon configuration to direnv and the user.
- **POSIX Bash only** — the executor reuses the Bash executor it extends; the shipped Windows composition mounts the PowerShell executor instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bootstrap refusal lists are copied from `packages/boot/app-boot/src/index.ts` because that guard's constants are private to the application-boot package; `tests/deny.spec.ts` reads the source and compares both lists, so drift fails CI without widening app-boot's public surface. The configuration schema repeats the parent executor's fields instead of composing them: a schemastery intersect cannot carry the parent's volatile fields, and the config catalog walks object schemas. `tests/config-schema.spec.ts` compares every repeated field and default with the parent's schema, so a parent change fails this package instead of drifting silently.

</details>
