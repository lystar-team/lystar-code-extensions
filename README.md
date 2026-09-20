# LYStar Code Extensions

面向 Pi coding agent 的 TypeSafe Extension 集合。

## 组件边界

| Extension | 默认加载 | 责任 |
| --- | --- | --- |
| `typesafe-guard` | 是 | 工具调用前的 Jev 预检、高影响操作确认和工具失败状态提示 |
| `typesafe-compaction` | 是 | 会话压缩和压缩失败回退 |
| `typesafe-skill-planner` | 是 | 根据当前请求选择 Skill，确定回复形态和本轮响应指导 |
| `typesafe-anti-slop` | 否 | 个人使用的 anti-ai-slop 变更复核；需要配合项目 Skill 和规则文件使用 |

每个 Extension 都有独立入口和事件边界。Guard 不注册会话压缩，也不注册 anti-ai-slop；Compaction 不参与工具预检；anti-ai-slop 不会随默认包自动启用。

共享请求、凭据、模型和地址配置位于 [`extensions/typesafe-core.mjs`](extensions/typesafe-core.mjs)。共享模块不是独立 Extension，不直接注册 Pi 事件。

## 安装默认组件

```bash
pi install git:github.com/lystar-team/lystar-code-extensions@v0.1.0
```

默认加载：

- `typesafe-guard`
- `typesafe-compaction`
- `typesafe-skill-planner`

## 单独试用

```bash
pi -e ./extensions/typesafe-guard.ts
pi -e ./extensions/typesafe-compaction.ts
pi -e ./extensions/typesafe-skill-planner.ts
```

## 选装 anti-ai-slop

anti-ai-slop 是个人工作流 Extension，不属于默认加载链路，也不进入公开包归档。它依赖项目中的 Skill、规则文件和业务取证流程，不应当被当成通用 Guard 能力。

从当前仓库源码试用：

```bash
pi -e ./extensions/typesafe-anti-slop.ts
```

规则文件位于 `rules/anti-ai-slop.rules.json`，可以通过 `TYPESAFE_ANTI_SLOP_RULES_PATH` 指向个人规则文件。后续若需要让其他用户独立安装，应把它整理为单独的 Pi Package 或独立仓库，不把个人规则并入默认组件包。

anti-ai-slop 不会修改规则、不自动阻断工具调用，也不会代替项目 Skill 的业务判断。

## API 配置

```bash
export TYPESAFE_API_KEY='你的 TypeSafe API Key'
```

也可以把 Key 写入：

```text
$XDG_CONFIG_HOME/lystar-code/typesafe-api-key
```

未设置 `XDG_CONFIG_HOME` 时，默认路径是：

```text
~/.config/lystar-code/typesafe-api-key
```

Key 文件只保存一行 Key。Extension 不会创建、修改或上传这个文件。

## 环境变量

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe API Key | 无 |
| `TYPESAFE_API_KEY_FILE` | Key 文件路径 | `~/.config/lystar-code/typesafe-api-key` |
| `TYPESAFE_BASE_URL` | TypeSafe API 地址 | `https://api.typesafe.ai` |
| `TYPESAFE_MODEL` | Jev 模型 | `jev-1.13.0` |
| `TYPESAFE_DEFAULT_MODEL` | `TYPESAFE_MODEL` 未设置时的模型 | `jev-1.13.0` |
| `TYPESAFE_REQUEST_TIMEOUT_MS` | 共享请求超时 | `1800` |
| `TYPESAFE_GUARD_TIMEOUT_MS` | Guard 预检超时 | `1800` |
| `TYPESAFE_SKILL_PLANNER_TIMEOUT_MS` | Skill Planner 请求超时 | `1800` |
| `TYPESAFE_COMPACTION_TIMEOUT_MS` | Compaction 请求超时 | `12000` |
| `TYPESAFE_ANTI_SLOP_TIMEOUT_MS` | anti-ai-slop 请求超时 | `8000` |
| `TYPESAFE_GUARD_DEBUG` | 输出 Guard 调试日志 | `0` |
| `TYPESAFE_COMPACTION_DEBUG` | 输出 Compaction 调试日志 | `0` |
| `TYPESAFE_SKILL_PLANNER_DEBUG` | 输出 Planner 调试日志 | `0` |
| `TYPESAFE_DEBUG` | 输出共享客户端调试信息 | `0` |
| `TYPESAFE_GUARD_DISABLE` | 关闭 Guard 工具预检 | `0` |
| `TYPESAFE_COMPACTION_DISABLE` | 关闭 Jev 会话压缩 | `0` |
| `TYPESAFE_SKILL_PLANNER_DISABLE` | 关闭 Skill Planner | `0` |
| `TYPESAFE_SKILL_PLANNER_STATUS` | 在 Pi 状态栏显示选中的 Skill | `0` |
| `TYPESAFE_ANTI_SLOP_DISABLE` | 关闭 anti-ai-slop | `0` |
| `TYPESAFE_ANTI_SLOP_RULES_PATH` | 自定义 anti-ai-slop 规则文件 | 包内规则文件 |

## 运行行为

### typesafe-guard

Guard 默认跳过只读工具和只读 Shell 命令。写文件、编辑文件以及非只读命令会进入 Jev 预检。

只有同时满足以下条件时，Extension 才会要求人工确认：

- 操作属于高影响操作，例如访问工作目录外路径、`sudo`、`ssh`、`scp`、强制删除、`git push` 或服务重启；
- Jev 判断需要确认，或判断任务关联度很低且操作明显越界。

Jev 请求失败、超时或没有 API Key 时，Guard 不阻断普通开发流程。高影响操作在无 UI 模式下无法弹出确认，会被阻断并返回原因。

### typesafe-compaction

Compaction 只监听 `session_before_compact`。它使用独立配置和独立日志，不参与工具调用预检。

Jev 请求失败、超时、没有 API Key 或压缩结果无法使用时，Extension 返回明确回退原因，由 Pi 使用原生压缩流程。错误工具结果和受保护的写操作不会被 Jev 删除。

### typesafe-skill-planner

Planner 只追加本轮响应指导，不修改 Skill 内容，也不替代 Pi 的 Skill 发现机制。

没有 API Key、请求失败或 Extension 被关闭时，Planner 不追加指导，主流程继续运行。用户在请求中显式指定的 Skill 会保留在计划中。计划只影响当前请求；Session 切换时会清理上一轮计划。

### typesafe-anti-slop

anti-ai-slop 使用 `agent_settled` 复核最终变更，并注册 `/slop-check` 手动检查命令。它只在被显式加载时运行。

规则只产生复核提示，不自动阻断工具调用。证据不足时保持待取证状态，不凭通用偏好修改代码。这个 Extension 面向 Yean 的个人 Skill 工作流，规则、业务取证和项目上下文需要由使用者自行维护。

## 数据发送范围

为完成判断，Extension 可能向 `TYPESAFE_BASE_URL` 发送：

- 当前用户请求；
- 最近的 Assistant 计划和工具活动摘要；
- 工具名称、工作目录、文件路径和命令摘要；
- Edit 的限定长度变更片段；
- anti-ai-slop 复核所需的项目事实；
- Skill 名称、Skill 描述和上一轮选择结果；
- 会话压缩所需的历史消息、工具调用和工具结果。

请求会限制长度，并对常见 Bearer、API Key、Token、Password 和 Secret 格式进行脱敏。脱敏不是业务数据匿名化；发送前仍应检查当前请求和工作目录是否包含不应离开本机的信息。

可以使用 `TYPESAFE_BASE_URL` 接入自有兼容服务，也可以通过功能开关关闭对应能力。详细边界见 [`SECURITY.md`](SECURITY.md)。

## 开发与验证

需要 Node.js 20 或更高版本：

```bash
npm ci
npm run check
npm run pack:check
```

测试使用本地 Mock，不连接真实 TypeSafe API，不需要真实 API Key。

## 目录结构

```text
extensions/
├── typesafe-guard.ts
├── typesafe-compaction.ts
├── typesafe-skill-planner.ts
├── typesafe-anti-slop.ts
├── typesafe-core.mjs
├── typesafe-compaction/
│   └── compaction.ts
└── typesafe-anti-slop/
    └── anti-slop.mjs
```

## 版本与发布

版本号位于 [`VERSION`](VERSION)，并与 `package.json` 保持一致。发布使用 `vMAJOR.MINOR.PATCH` Tag。Tag 推送后，GitHub Actions 会重新执行检查并生成 npm 包归档。

变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。贡献方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
