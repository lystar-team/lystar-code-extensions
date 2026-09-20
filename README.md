# LYStar Code Extensions

面向 Pi coding agent 的 TypeSafe Extension 集合。

## 组件边界

| Extension | 默认加载 | 责任 |
| --- | --- | --- |
| `lystar-jev-guard` | 是 | 工具调用前的 Jev 预检、高影响操作确认和工具失败状态提示 |
| `lystar-jev-compaction` | 是 | 会话压缩和压缩失败回退 |
| `lystar-jev-skill-planner` | 是 | 根据当前请求选择 Skill，确定回复形态和本轮响应指导 |
| `lystar-jev-anti-slop` | 否 | 变更复核；需要配合项目 Skill 和规则文件使用 |

每个 Extension 都有独立入口和事件边界。Guard 不注册会话压缩，也不注册 anti-ai-slop；Compaction 不参与工具预检；anti-ai-slop 不会随默认包自动启用。

共享请求、凭据、模型和地址配置位于 [`extensions/typesafe-core.mjs`](extensions/typesafe-core.mjs)。共享模块不是独立 Extension，不直接注册 Pi 事件。

## 安装默认组件

```bash
pi install git:github.com/lystar-team/lystar-code-extensions@v0.1.0
```

默认加载：

- `lystar-jev-guard`
- `lystar-jev-compaction`
- `lystar-jev-skill-planner`

## 单独试用

```bash
pi -e ./extensions/lystar-jev-guard.ts
pi -e ./extensions/lystar-jev-compaction.ts
pi -e ./extensions/lystar-jev-skill-planner.ts
```

## 选装 anti-ai-slop

anti-ai-slop 是选装的变更复核 Extension，不属于默认加载链路，也不进入公开包归档。它配合项目中的 Skill、规则文件和业务取证流程使用，不应当被当成通用 Guard 能力。

从当前仓库源码试用：

```bash
pi -e ./extensions/lystar-jev-anti-slop.ts
```

规则文件位于 `rules/anti-ai-slop.rules.json`，可以通过 `TYPESAFE_ANTI_SLOP_RULES_PATH` 指定规则文件。该 Extension 与默认组件包分开维护。

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
| `TYPESAFE_REQUEST_CHARS` | 单次 Jev 请求体字符预算 | `65536` |
| `TYPESAFE_REQUEST_TOKENS` | 单次 Jev 请求的 Token 预算 | `40000` |
| `TYPESAFE_REQUESTS_PER_ROUND` | 单轮 Jev 请求数上限 | `20` |
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

### lystar-jev-guard

Guard 默认跳过只读工具和只读 Shell 命令。写文件、编辑文件以及非只读命令会进入 Jev 预检。

只有同时满足以下条件时，Extension 才会要求人工确认：

- 操作属于高影响操作，例如访问工作目录外路径、`sudo`、`ssh`、`scp`、强制删除、`git push` 或服务重启；
- Jev 判断需要确认，或判断任务关联度很低且操作明显越界。

Jev 请求失败、超时或没有 API Key 时，Guard 不阻断普通开发流程。相同用户请求、分支和动作指纹的已完成判断会在本轮复用；工具执行失败后清空这类缓存。高影响操作在无 UI 模式下无法弹出确认，会被阻断并返回原因。

### lystar-jev-compaction

Compaction 只监听 `session_before_compact`。它使用独立配置和独立日志，不参与工具调用预检。

Compaction 直接使用 Pi `session_before_compact` 提供的 preparation：`messagesToSummarize` 和 split-turn 的 `turnPrefixMessages` 是本轮待压缩历史，`firstKeptEntryId` 之后的分支消息只作为保留窗口上下文；不再按最后一条 compaction 自行截断历史。Jev 状态只拟合一次，所有请求共享同一份状态；预算按请求体形态计量，状态与摘要都有下限保证：状态逐级省略正文、仍不足时按最近 200 次调用封顶并只对状态里出现的调用提问，摘要逐级缩写、到最后一档时只逐条展开最近 200 条旧消息，更早的用户消息、工具失败和写操作目标仍然保留。摘要预算按窗口份额（0.4 × 上下文窗口）计算，并用 120,000 Token 绝对上限拦住大窗口，因此 1M 窗口不会产生成倍变大的常驻摘要。只有 Jev 请求失败或内容确实无法压缩时才回退。Jev 请求失败、超时、没有 API Key 或压缩结果无法使用时，Extension 返回明确回退原因，由 Pi 使用原生压缩流程。整段历史都在保留窗口内、或用户取消时只给出中文说明，不报回退（这两种情况本就没有可压缩的内容，Pi 自己也不产生任何提示）。错误工具结果不会被 Jev 删除；受保护的写操作条目、文件路径和 1,000 字符入参开头在紧凑档位仍然保留。

### lystar-jev-skill-planner

Planner 只追加本轮响应指导，不修改 Skill 内容，也不替代 Pi 的 Skill 发现机制。

没有 API Key、请求失败或 Extension 被关闭时，Planner 不追加指导，主流程继续运行。用户显式指定的 Skill 保留在计划中，只再询问一次回复模式与简洁程度，且不携带 Skill 候选列表；显式与非显式请求都按请求指纹复用计划，指纹包含请求正文、Skill 名称与描述、上一轮已选 Skill，因此切换 Skill 会重新询问。没有可用 Skill 时不询问 Jev。计划只影响当前请求；Session 切换时会清理计划缓存。

### lystar-jev-anti-slop

anti-ai-slop 使用 `agent_settled` 复核最终变更，并注册 `/slop-check` 手动检查命令。它只在被显式加载时运行。

规则只产生复核提示，不自动阻断工具调用。证据不足时保持待取证状态，不凭通用偏好修改代码。该 Extension 需要项目 Skill、规则和业务上下文共同提供复核依据。初筛与复核都按请求体预算分批发送，单批不超过 64KB；同一片段不会被重复路由。规则可用 `appliesTo` 声明适用的文件扩展名，未声明时对所有文件生效。

## 数据发送范围

为完成判断，Extension 可能向 `TYPESAFE_BASE_URL` 发送：

- 当前用户请求；
- 最近的 Assistant 计划和工具活动摘要；
- 工具名称、工作目录、文件路径和命令摘要；
- Edit 的限定长度变更片段；
- anti-ai-slop 复核所需的项目事实；
- Skill 名称、Skill 描述和上一轮选择结果；
- 会话压缩所需的 canonical summary、近期目标、候选工具名称、输入摘要和结果头部；不会在每个候选批次重复发送完整历史。

请求会限制长度，并对常见 Bearer、API Key、Token、Password 和 Secret 格式进行脱敏。Guard 的阶段性判断缓存只保存在当前 Pi 进程内，不写入 Session。脱敏不是业务数据匿名化；发送前仍应检查当前请求和工作目录是否包含不应离开本机的信息。

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
├── lystar-jev-guard.ts
├── lystar-jev-compaction.ts
├── lystar-jev-skill-planner.ts
├── lystar-jev-anti-slop.ts
├── typesafe-core.mjs
├── lystar-jev-compaction/
│   └── compaction.ts
└── lystar-jev-anti-slop/
    └── anti-slop.mjs
```

## 版本与发布

版本号位于 [`VERSION`](VERSION)，并与 `package.json` 保持一致。发布使用 `vMAJOR.MINOR.PATCH` Tag。Tag 推送后，GitHub Actions 会重新执行检查并生成 npm 包归档。

变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。贡献方式见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
