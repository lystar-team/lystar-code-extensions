# 安全与数据边界

## Extension 权限

Pi Extension 在 Pi 进程内运行，拥有启动 Pi 的用户权限。它不是沙箱，也不会限制 Pi 的文件、命令或网络能力。安装前请审阅源码，运行不受信任的仓库时使用隔离环境。

## 发送到 TypeSafe API 的内容

各个已启用的 Extension 为完成判断，可能发送：

- 用户请求；
- 工作目录和文件路径；
- 工具名称、命令摘要和 Edit/Write 内容片段；
- 最近 Assistant 计划和工具活动；
- Skill 名称、描述和选择结果；
- 会话压缩所需的上一份 canonical summary、Pi preparation 提供的待压缩消息与 split-turn 前缀、`firstKeptEntryId` 之后的保留窗口上下文、候选工具名称、输入摘要和结果头部；Compaction 不在每个候选批次重复发送完整历史，也不自行绕过 Pi 的保留边界；
- anti-ai-slop 规则要求读取的项目事实。

请求有长度限制。Guard 的阶段性判断缓存只存在于当前 Pi 进程，不写入 Session 或请求正文。代码会对常见的 Bearer、API Key、Token、Password 和 Secret 格式做脱敏，但不能识别所有业务机密，也不承诺业务级匿名化。

## 凭据

API Key 来源只有：

- `TYPESAFE_API_KEY`；
- `TYPESAFE_API_KEY_FILE`；
- 默认用户配置文件。

Key 不写入仓库，不写入 Session，不写入请求正文。若开启调试日志，仍应避免在终端环境中暴露凭据。

## 关闭远程判断

```bash
export TYPESAFE_GUARD_DISABLE=1
export TYPESAFE_SKILL_PLANNER_DISABLE=1
export TYPESAFE_COMPACTION_DISABLE=1
export TYPESAFE_ANTI_SLOP_DISABLE=1
```

四个开关分别作用于四个 Extension。Guard、Compaction 和 Skill Planner 的默认入口会随包加载；anti-ai-slop 必须显式加载后才会参与会话。

## 报告漏洞

不要在公开 Issue 中提交 API Key、用户代码、工作目录、请求正文或可利用细节。请通过 GitHub 私密安全通道提交，或先联系仓库维护者确认安全报告入口。
