# LYStar Code Extensions 维护说明

- 这是 Pi Extension Package，不是业务页面项目。
- 公开包不能包含凭据、Session、用户代码、私有路径或运行结果。
- TypeSafe API、模型、Key、超时和响应解析以 `extensions/typesafe-core.mjs` 为事实源。
- Guard、Compaction、Skill Planner 和 anti-ai-slop 是四个独立 Extension；不要在其中一个入口注册另一个能力的事件。
- anti-ai-slop 只作为选装的变更复核 Extension，不进入默认 `pi.extensions` 列表。
- Extension 行为变化必须同步更新测试、README、SECURITY.md 和 CHANGELOG.md。
- 测试不得连接真实 TypeSafe API。
- 发布前运行 `npm run check` 和 `npm run pack:check`。
- 版本号必须同步 `VERSION` 与 `package.json`，发布 Tag 使用 `vMAJOR.MINOR.PATCH`。
