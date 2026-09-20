# 贡献指南

## 开发环境

- Node.js 20 或更高版本
- npm
- 一个可加载 Pi Extension 的开发环境

安装依赖：

```bash
npm ci
```

## 修改范围

- `typesafe-guard` 负责工具预检、确认、会话压缩和最终变更复核。
- `typesafe-skill-planner` 负责 Skill 选择和本轮响应指导。
- `extensions/typesafe-core.mjs` 是共享 API、凭据和配置事实源。
- `rules/anti-ai-slop.rules.json` 只保存规则数据，不在检查器中复制规则。

共享配置、TypeSafe 请求格式和错误处理发生变化时，必须同时更新对应测试、README 和 CHANGELOG。

不要提交：

- API Key、密码、Token、Cookie 或私钥；
- 本地 Session、运行日志和用户工作区内容；
- 个人绝对路径；
- 真实项目中的未经脱敏代码或业务数据。

## 验证

提交前运行：

```bash
npm run check
npm run pack:check
```

测试必须使用本地 Mock，不连接真实 TypeSafe API。

## 提交与发布

提交信息使用中文 Conventional Commit：

```text
feat: 增加 Skill Planner 的响应模式选择

- 说明新增的用户可见行为
- 说明配置、测试或兼容边界
```

发布流程：

1. 更新 `VERSION`、`package.json` 和 `CHANGELOG.md`；
2. 运行全部检查；
3. 创建 `vMAJOR.MINOR.PATCH` Tag；
4. 推送 Tag；
5. 由 GitHub Actions 构建 Release 资产。
