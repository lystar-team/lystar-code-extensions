# 变更记录

## 未发布

- 将 `lystar-jev-guard`、`lystar-jev-compaction`、`lystar-jev-skill-planner` 和 `lystar-jev-anti-slop` 拆成独立入口。
- 将会话压缩从 Guard 移出，默认包只加载 Guard、Compaction 和 Skill Planner。
- 将 anti-ai-slop 改为选装的变更复核 Extension，不再由 Guard 自动注册。
- 增加四个 Extension 的组合加载边界测试。

## 0.1.0 - 2026-09-20

- 首次整理 `lystar-jev-guard` 和 `lystar-jev-skill-planner` 为 Pi Package。
- 增加共享 TypeSafe API 客户端、配置和凭据读取模块。
- 随包分发 anti-ai-slop 默认规则。
- 增加测试、类型检查、包检查和 GitHub Actions 工作流。
