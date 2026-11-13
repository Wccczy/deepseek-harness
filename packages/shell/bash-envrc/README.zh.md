---
description: "通过 direnv export json 加载每个项目 .envrc 环境的 Bash 执行器，面向把各项目工具链、语言运行时和工具账户放在 direnv 里的部署。"
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-envrc

[English](README.md) | 中文

## 概述

当每个项目目录都在 `.envrc` 中定义自己的环境、而模型的 bash 命令必须看到该环境时，使用 `dsh-bash-envrc`。本执行器替代 `dsh-bash-sandbox` 并保留沙箱执行器的机制：命令仍受同一份按调用策略约束，超时与后台任务不变，面向模型的 `bash` 工具也无需改动。执行每条命令前，它向 `direnv export json` 询问工作目录的项目环境，只保留命令原本不会继承的条目，拒绝项目文件绝不应控制的所有名称，再把其余条目合并到调用方显式环境映射的下面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时选择

当同一台机器承载多个需要不同工具链、语言运行时或工具账户的项目或 worktree，且它们都已用 `.envrc` 描述该环境时，用它替代 `dsh-bash-sandbox`。本执行器是通用的：它在过滤之后转发 direnv 导出的内容，因此由 `.envrc` 决定存在哪些变量，本包自身从不指涉任何厂商、工具或账户。没有 `.envrc` 文件的部署直接挂载 `dsh-bash-sandbox`；此时本执行器不解析任何内容，只表现出与“没有项目文件的目录”相同的环境透传行为。

### 命令环境如何解析

解析按命令进行，因为 `workdir` 由模型选择，调用之间可能跨项目或跨 worktree。

1. 解析后的 `workdir` 先经 `realpath` 规范化，与 direnv 自己的路径处理一致。
2. 从该目录向上查找最近的 `.envrc`；除非文件自身要求更多，direnv 只加载这一个文件。没有 `.envrc` 时命令的运行方式与父执行器完全相同，不启动子进程，也不改变环境。
3. `envrc.command`（默认 `['direnv', 'export', 'json']`）在工作目录内通过 `ctx.subprocess` 运行，受自己的截止时间与输出上限约束，并会移除继承的 `DIRENV_*` 簿记，因此从 direnv shell 内启动的 harness 仍能确定性地解析目标目录。它的 JSON 对象提供候选条目；`null` 值是 direnv 的“未设置”标记，不携带任何内容，空导出（命令环境已经一致）不贡献任何条目。
4. 候选条目先经下文过滤，再与 harness 进程环境比较一次：命令原本就会继承的同值条目被丢弃，因此项目文件绝不会整体替换 `PATH`、`HOME` 或任何其他继承值。
5. 存留的条目以 `{ ...resolved, ...spec.env }` 合并：项目环境位于调用方显式 `env` 之下，而受管的 `dshEnv` 快照仍在执行器内部最后合并。

成功结果与“没有项目文件”的结果会按工作目录缓存 `envrc.cacheMs` 时长，键为规范化目录、`.envrc` 路径及其修改时间与大小。修改 `.envrc` 文件会立即让缓存条目失效；失败从不缓存，因此被拒绝或超时的解析会在下一条命令上重试。

### 哪些变量会被拒绝

拒绝名单先于 `envrc.allow` 执行，因此 allow 条目绝不可能重新放行被拒绝的名称。bootstrap 名单与前缀是应用启动守卫的副本，该守卫决定被发现的 `.env` 文件可以设置哪些变量（[源码](../../boot/app-boot/src/index.ts)）；有测试读取该文件，副本漂移即失败。

| 拒绝对象 | 示例 |
|---|---|
| bootstrap 名称（进程启动、模块解析、解释器钩子、VCS 钩子、网络信任） | `PATH`、`HOME`、`BASH_ENV`、`NODE_OPTIONS`、`LD_PRELOAD`、`GIT_SSH_COMMAND`、`SSL_CERT_FILE`、`HTTP_PROXY` |
| bootstrap 前缀 | `DSH_`、`XDG_`、`DYLD_`、`BASH_FUNC_` |
| direnv 自身的簿记变量 | `DIRENV_DIFF`、`DIRENV_DIR`、`DIRENV_FILE`、`DIRENV_WATCHES` |
| 形似凭据的名称 | 任意大小写中包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的名称 |
| 配置的 `envrc.deny` 条目 | 部署额外添加的任何名称 |

`envrc.allow` 是收紧开关，不是默认形态。留空时，导出中未被上述规则拒绝的每个条目都会通过；这正是需要同时使用多个变量的项目的预期形态，例如按项目设置 `GOPATH`、`JAVA_HOME`、`GOROOT`、`GEM_HOME` 或 `GH_CONFIG_DIR`。仅当项目环境必须限制在一份已知清单内时才设置它：

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

即使 allow 为空，bootstrap 专用名称仍会被拒绝：例如 `NODE_EXTRA_CA_CERTS` 属于应用启动的网络信任名单，因此项目文件无法把 CA 证书包安装进模型 shell 命令。需要它的部署应在 Harness home 环境中设置。

### 配置

这些字段扩展本地执行器自身的配置（`cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs`），后者保留自己的默认值；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-bash-envrc)是穷尽式真源。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `envrc.enabled` | `true` | 是否解析项目环境；为 false 时行为与父执行器完全一致。 |
| `envrc.command` | `['direnv', 'export', 'json']` | 打印 JSON 导出的命令；按 argv 执行，绝不经过 shell 解释。 |
| `envrc.timeoutMs` | `10000` | 单次解析的截止时间，独立于命令自身的超时。 |
| `envrc.allow` | `[]` | 非空时只有列出的名称可通过；比较不区分大小写。 |
| `envrc.deny` | `[]` | 在内置名单之上额外拒绝的名称；比较不区分大小写。 |
| `envrc.failOnRefusal` | `true` | direnv 拒绝 `.envrc` 时是否让命令失败；为 false 时记录日志并以环境继承值运行。 |
| `envrc.cacheMs` | `30000` | 已解析环境与“没有 `.envrc`”结果的缓存保留时长。 |

### 失败

静默回退会重现本执行器要修复的缺陷，因此除配置的降级外，每次失败都响亮报出，并携带工具结果会保留的稳定错误码。

| 错误码 | 原因 | 行为 |
|---|---|---|
| `ENVRC_REFUSED` | 配置的命令以 `1` 退出，通常是 `.envrc` 未获批准 | 工具调用失败；消息给出目录并要求执行 `direnv allow <dir>`。设置 `failOnRefusal: false` 时，命令以环境继承值运行，插件改为记录拒绝日志。 |
| `ENVRC_UNAVAILABLE` | 可执行文件无法启动 | 工具调用失败；消息提示安装 direnv 或修改 `envrc.command`。 |
| `ENVRC_TIMEOUT` | 解析超过 `envrc.timeoutMs` | 工具调用失败；命令绝不运行。 |
| `ENVRC_OUTPUT` | 输出超过上限、不是 JSON，或提供方未返回捕获的流 | 工具调用失败。 |
| `ENVRC_FAILED` | 其他启动失败或非零退出状态 | 工具调用失败；消息包含退出状态与捕获的 stderr。 |

### 在 profile 中启用

base bundle 用 `- id: bash-sandbox` 占据 `ctx.shell`（[base bundle](../../bundle/base/cordis.patch.yml)），且只能挂载一个执行器：第二次注册会在加载时失败。patch 的 `name` 用于选择它要作用的行，不能给该行改名，名称不匹配会被跳过并告警。要替换随包发布的执行器，请禁用它的行，并以本插件自己的 id 插入，形状与 PowerShell 测试通道相同（[示例](../../../apps/web/tests/pwsh-terminal.overlay.yml)）。先把包安装进 profile 的包集合，再把以下内容加入 profile 的 `cordis.patch.yml`：

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

在 Windows 上，随包发布的组合挂载 `pwsh-sandbox` 并禁用 `bash-sandbox`；本执行器继承 Bash 执行器的 POSIX 契约，不能替代 PowerShell 槽位。

-----

<a id="understand-the-implementation"></a>
## 理解实现

本包是一个沙箱执行器子类加三个辅助模块。它从不复制执行器的 argv 或生命周期逻辑：`execute()` 解析项目环境，然后带着增强环境后的 spec 调用 `SandboxBashExecutor.execute()`，因此沙箱隔离、截止时间、后台句柄、输出收集与 spill 文件都保持被替代执行器的精确语义。

| 源码 | 职责 |
|---|---|
| `src/index.ts` | `EnvrcBashExecutor`：配置 schema、按命令解析、缓存归属，以及失败到工具错误的映射。 |
| `src/envrc.ts` | `.envrc` 发现、导出解析、缓存键与 TTL 缓存。 |
| `src/deny.ts` | 复制的 bootstrap 拒绝名单、`DIRENV_*` 与凭据规则，以及 allow/deny/基线筛选。 |
| `src/errors.ts` | `EnvrcError` 及其稳定错误码。 |
| `src/subprocess.ts` | 解析命令的捕获流访问。 |

缓存在执行器实例上，插件 fiber 释放时清空，因此重载从干净状态开始，组合之间不残留模块级状态。

<a id="further-exploration"></a>
## 进一步探索

- [Shell 执行器子系统](../../../docs/subsystems/shell.zh.md) — 本插件实现的请求/spec 词汇与执行器契约。
- [子进程子系统](../../../docs/subsystems/subprocess.zh.md) — 每次解析与命令都会继承的凭据清洗与环境合并顺序。
- [Shell 包组](../README.zh.md) — 其他 Bash 与 PowerShell 执行器及其工具。

<a id="model-experience"></a>
## 模型体验

间接地通过 `dsh-tool-bash` 体现：该工具渲染每条命令的输出并保持 schema 不变，本执行器只决定每条命令启动时的环境。

#### KV Cache 影响

不直接造成失效；请求前缀的任何变化由上述消费方负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **只有 shell 执行器调用能看到项目环境** — MCP server、subagent CLI 与 PTC worker 不经过 `ctx.shell`，因此项目变量只有通过部署方其他途径提供时才会到达它们。
- **`.envrc` 以 harness 权限运行** — 解析把 direnv 作为宿主进程启动，因此已批准的 `.envrc` 在命令沙箱之外执行，可读取 harness 进程可读的一切。direnv 自己的 allow 门禁就是信任边界；本插件绝不运行 `direnv allow`。
- **启动 shell 的环境变量不会被卸载** — 执行器只转发 direnv 为命令目录导出的内容，且从不移除继承变量，因此启动 harness 的 shell 导出的值会一直出现在每条命令中，即使另一个项目的 `.envrc` 并未设置它。
- **`.envrc` 所 source 文件的变化在缓存过期前不可见** — 缓存键只覆盖 `.envrc` 路径、修改时间与大小；被包含文件的变化在 `envrc.cacheMs` 之后才生效。
- **每次缓存未命中都要付出一个子进程的代价** — 目录中的第一条命令要等待 `direnv export json`；默认 10 秒截止时间约束缓慢或交互式的 `.envrc`。
- **不控制 `direnv` 守护进程，也不执行 `direnv allow`** — 插件原样使用配置的命令，把批准、阻止决策与守护进程配置留给 direnv 与用户。
- **仅限 POSIX Bash** — 执行器复用它扩展的 Bash 执行器；随包发布的 Windows 组合改为挂载 PowerShell 执行器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

bootstrap 拒绝名单复制自 `packages/boot/app-boot/src/index.ts`，因为该守卫的常量是 application-boot 包的私有实现；`tests/deny.spec.ts` 读取源码并比较两份名单，因此漂移会让 CI 失败，而无需扩大 app-boot 的公开接口。配置 schema 重复父执行器的字段，而不是组合它们：schemastery 的 intersect 无法携带父执行器的 volatile 字段，而配置目录遍历的是对象 schema。`tests/config-schema.spec.ts` 会把每个重复字段与默认值和父 schema 对比，因此父执行器的变化会让本包失败，而不是悄悄漂移。

</details>
