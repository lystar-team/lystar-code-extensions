import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { loadRules, captureWorkspaceBaseline, collectFinalChanges, diffHunks, semanticRoute, judgeWithEvidence, inspectChanges, formatReport, needsAttention, proposedContent, registerAntiSlop } from '../extensions/lystar-jev-anti-slop/anti-slop.mjs';

const rules = loadRules();
const rule = id => rules.find(item => item.id === id);
const routeAnswer = (questions, selected = [0], yes = 0.9, no = 0.05) => ({ answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, { type: 'noul', noul: selected.includes(index) ? yes : no }])) });
const judgmentAnswer = ({ violation = 0.95, evidence = 0.95 } = {}) => ({ answers: {
  violation: { type: 'noul', noul: violation },
  evidence_sufficient: { type: 'noul', noul: evidence },
} });
function temporary(run) {
  const directory = mkdtempSync(join(tmpdir(), 'anti-slop-test-'));
  return Promise.resolve().then(() => run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}
function harness(ask) {
  const hooks = new Map(); const commands = new Map(); const messages = [];
  const pi = { on: (name, handler) => hooks.set(name, handler), registerCommand: (name, value) => commands.set(name, value), sendMessage: (message, options) => messages.push({ ...message, options }) };
  registerAntiSlop(pi, ask);
  return { hooks, commands, messages };
}
function initGit(directory) {
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', ['-C', directory, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', directory, 'config', 'user.name', 'Test']);
}

test('规则注册表只维护业务规则、例外和必需证据', () => {
  assert.equal(rules.length, 13);
  const required = ['user-facing-plain-language', 'user-centered-information-architecture', 'design-spec-compliance', 'frontend-component-decomposition', 'performance-conscious-implementation', 'business-realistic-test-data'];
  assert(required.every(id => rule(id)));
  assert(rules.every(item => item.enabled && item.action === 'review' && item.requiredEvidence.length && item.bad && item.good));
  assert(rules.every(item => item.routing === undefined));
});
test('规则配置拒绝重复 ID 和未经确认的阻断模式', () => temporary(async directory => {
  const path = join(directory, 'rules.json');
  writeFileSync(path, JSON.stringify({ version: 1, rules: [rules[0], rules[0]] }));
  assert.throws(() => loadRules(path), /重复/);
  writeFileSync(path, JSON.stringify({ version: 1, rules: [{ ...rules[0], action: 'block' }] }));
  assert.throws(() => loadRules(path), /阻断/);
}));
test('diff 分块不依赖正则，并保留精确修改行', () => {
  const before = ['a', 'keep-1', 'b', 'keep-2', 'c'].join('\n');
  const after = ['a', 'changed-one', 'keep-1', 'b', 'keep-2', 'changed-two', 'c'].join('\n');
  const result = diffHunks(before, after, 0);
  assert.equal(result.hunks.length, 2);
  assert.equal(result.hunks[0].changedAfter, 'changed-one');
  assert.equal(result.hunks[0].changedStartLine, 2);
  assert.equal(result.hunks[1].changedAfter, 'changed-two');
});
test('纯删除不产生反 AI 味候选', () => {
  assert.equal(diffHunks('a\nremove\nb', 'a\nb').hunks.length, 0);
});
test('语义初筛对任意修改片段询问全部规则，不依赖关键词命中', async () => {
  const change = { path: 'Page.vue', before: '', after: '<X />' };
  const hunk = diffHunks('', '<X />').hunks[0];
  const selected = await semanticRoute(change, hunk, rules, '业务页面', async (state, questions) => {
    assert.equal(state.change.changedAfter, '<X />');
    assert.equal(Object.keys(questions).length, rules.length);
    return routeAnswer(questions, [4]);
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].rule.id, 'reuse-public-component');
});
test('聚焦判断只接收一条规则和 LC 后续读取的项目证据', async () => {
  const candidate = { path: 'Orders.vue', rule: rule('dictionary-label-required'), applicability: 0.9, hunk: diffHunks('', '<span>{{ row.status }}</span>').hunks[0] };
  const finding = await judgeWithEvidence(candidate, '订单列表', [{ tool: 'read', path: 'dict.ts', content: 'order_status 使用 DictLabel' }], async (state, questions) => {
    assert.equal(state.rule.id, 'dictionary-label-required');
    assert.equal(state.project_evidence.length, 1);
    assert.deepEqual(Object.keys(questions).sort(), ['evidence_sufficient', 'violation']);
    return judgmentAnswer();
  });
  assert.equal(finding.status, 'review');
});
test('聚焦判断只发送最新六条定向证据', async () => {
  const candidate = { path: 'Orders.vue', rule: rule('dictionary-label-required'), applicability: 0.9, hunk: diffHunks('', '<span>{{ row.status }}</span>').hunks[0] };
  const evidence = Array.from({ length: 8 }, (_, index) => ({ tool: 'read', path: `e${index + 1}.txt`, content: `evidence-${index + 1}` }));
  await judgeWithEvidence(candidate, '订单列表', evidence, async state => {
    assert.equal(state.project_evidence.length, 6);
    assert.equal(state.project_evidence[0].content, 'evidence-3');
    assert.equal(state.project_evidence.at(-1).content, 'evidence-8');
    return judgmentAnswer({ violation: 0.05 });
  });
});
test('两阶段流程先请求取证，再用新增证据完成复核', async () => {
  const changes = [{ path: 'Orders.vue', before: '', after: '<span>{{ row.status }}</span>' }];
  const rounds = new Map(); let routeCalls = 0; let judgmentCalls = 0;
  const ask = async (_state, questions) => {
    if ('r0' in questions) { routeCalls++; return routeAnswer(questions, [0]); }
    judgmentCalls++; return judgmentAnswer();
  };
  const first = await inspectChanges(changes, [rule('dictionary-label-required')], '订单列表', [], rounds, ask);
  assert.equal(first.findings[0].stage, 'needs_evidence');
  assert.equal(judgmentCalls, 0);
  const second = await inspectChanges(changes, [rule('dictionary-label-required')], '订单列表', [{ tool: 'read', path: 'dict.ts', content: 'status 是 order_status 字典' }], rounds, ask);
  assert.equal(second.findings[0].stage, 'judged');
  assert.equal(second.findings[0].status, 'review');
  assert.equal(routeCalls, 1);
  assert.equal(judgmentCalls, 1);
});
test('证据不足保持 uncertain，证据充分且低违规概率为 clear', async () => {
  const candidate = { path: 'Page.vue', rule: rule('empty-description'), applicability: 0.9, hunk: diffHunks('', '<p>说明</p>').hunks[0] };
  const uncertain = await judgeWithEvidence(candidate, '页面', [{ tool: 'read', content: '未知用途' }], async () => judgmentAnswer({ evidence: 0.2 }));
  assert.equal(uncertain.status, 'uncertain');
  const clear = await judgeWithEvidence(candidate, '删除后不可恢复', [{ tool: 'read', content: '删除后不可恢复' }], async () => judgmentAnswer({ violation: 0.05, evidence: 0.9 }));
  assert.equal(clear.status, 'clear');
});
test('Git 基线覆盖未经过 write/edit 的最终修改', () => temporary(async directory => {
  initGit(directory);
  const path = join(directory, 'Page.vue');
  writeFileSync(path, '<h1>原始</h1>');
  execFileSync('git', ['-C', directory, 'add', '.']);
  execFileSync('git', ['-C', directory, 'commit', '-qm', 'init']);
  const baseline = await captureWorkspaceBaseline(directory);
  writeFileSync(path, '<h1>通过 bash 或 MCP 修改</h1>');
  const changes = await collectFinalChanges(baseline, new Map());
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, '<h1>原始</h1>');
  assert.match(changes[0].after, /bash 或 MCP/);
}));
test('Git 基线保留任务开始前已有改动，不把旧改动算成本轮新增', () => temporary(async directory => {
  initGit(directory);
  const path = join(directory, 'Page.vue');
  writeFileSync(path, '<h1>HEAD</h1>');
  execFileSync('git', ['-C', directory, 'add', '.']);
  execFileSync('git', ['-C', directory, 'commit', '-qm', 'init']);
  writeFileSync(path, '<h1>用户已有改动</h1>');
  const baseline = await captureWorkspaceBaseline(directory);
  writeFileSync(path, '<h1>本轮改动</h1>');
  const changes = await collectFinalChanges(baseline, new Map());
  assert.equal(changes[0].before, '<h1>用户已有改动</h1>');
}));
test('非 Git 项目沿用成功 write/edit 的首次基线', async () => {
  const path = join(tmpdir(), 'anti-slop-non-git.vue');
  const tracked = new Map([[path, '<h1>旧</h1>']]);
  writeFileSync(path, '<h1>新</h1>');
  try {
    const changes = await collectFinalChanges({ root: undefined, initial: new Map() }, tracked);
    assert.equal(changes.length, 1);
  } finally { rmSync(path, { force: true }); }
});
test('最终变更采集不静默截断超过二十个文件', () => temporary(async directory => {
  const tracked = new Map();
  for (let index = 0; index < 21; index++) {
    const path = join(directory, `Page${index}.vue`);
    tracked.set(path, '<h1>旧</h1>');
    writeFileSync(path, '<h1>新</h1>');
  }
  const changes = await collectFinalChanges({ root: undefined, initial: new Map() }, tracked);
  assert.equal(changes.length, 21);
}));
test('批量 edit 候选重建仍按原始文件唯一匹配', () => {
  assert.equal(proposedContent('one two', { edits: [{ oldText: 'one', newText: 'two' }, { oldText: 'two', newText: 'three' }] }, 'edit'), 'two three');
  assert.equal(proposedContent('one one', { oldText: 'one', newText: 'x' }, 'edit'), null);
});
test('内部报告区分待取证和确认候选，不展示无关规则', async () => {
  const changes = [{ path: 'Page.vue', before: '', after: '<small>ORDER CENTER</small>' }];
  const result = await inspectChanges(changes, [rule('decorative-english')], '中文页面', [], new Map(), async (_state, questions) => routeAnswer(questions, [0]));
  const report = formatReport(result, 'test');
  assert.match(report, /待取证/);
  assert.match(report, /Page.vue:1-1/);
  assert.doesNotMatch(report, /字典项必须展示翻译/);
  assert.equal(needsAttention(result), true);
});
test('扩展在任务稳定后最多执行两轮隐藏复核', () => temporary(async directory => {
  const path = join(directory, 'Page.vue');
  writeFileSync(path, '<h1>旧</h1>');
  let routeCount = 0; let judgeCount = 0; let judgedEvidence;
  const h = harness(async (state, questions) => {
    if ('r0' in questions) { routeCount++; return routeAnswer(questions, [3]); }
    judgeCount++;
    judgedEvidence = state.project_evidence;
    return judgmentAnswer();
  });
  const ctx = { cwd: directory };
  const policy = await h.hooks.get('before_agent_start')({ prompt: '中文页面', systemPrompt: 'base' }, ctx);
  assert.match(policy.systemPrompt, /按 diff 分块/);
  const write = { toolName: 'write', toolCallId: 'w', input: { path, content: '<small>ORDER CENTER</small>' } };
  h.hooks.get('tool_call')(write, ctx); writeFileSync(path, write.input.content); h.hooks.get('tool_result')({ ...write, content: [], isError: false });
  await h.hooks.get('agent_settled')({}, ctx);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].display, false);
  h.hooks.get('tool_result')({ toolName: 'mcp', toolCallId: 'r', input: { tool: 'browser_probe' }, content: [{ type: 'text', text: '目标页面只使用中文，未配置双语标题' }], isError: false });
  await h.hooks.get('agent_settled')({}, ctx);
  assert.equal(h.messages.length, 2);
  await h.hooks.get('agent_settled')({}, ctx);
  assert.equal(h.messages.length, 2);
  assert.equal(routeCount, 1);
  assert.equal(judgeCount, 1);
  assert.equal(judgedEvidence[0].tool, 'mcp');
  assert.match(judgedEvidence[0].content, /只使用中文/);
}));
test('没有语义候选时保持静默', () => temporary(async directory => {
  const path = join(directory, 'Page.vue');
  writeFileSync(path, '<h1>旧</h1>');
  const h = harness(async (_state, questions) => routeAnswer(questions, []));
  const ctx = { cwd: directory };
  await h.hooks.get('before_agent_start')({ prompt: '改标题', systemPrompt: '' }, ctx);
  const write = { toolName: 'write', toolCallId: 'w', input: { path, content: '<h1>新</h1>' } };
  h.hooks.get('tool_call')(write, ctx); writeFileSync(path, write.input.content); h.hooks.get('tool_result')({ ...write, content: [], isError: false });
  await h.hooks.get('agent_settled')({}, ctx);
  assert.equal(h.messages.length, 0);
}));
test('手动审计复用同一语义流程', () => temporary(async directory => {
  const notices = [];
  const path = join(directory, 'Page.vue');
  writeFileSync(path, '<small>ORDER CENTER</small>');
  const h = harness(async (_state, questions) => routeAnswer(questions, [3]));
  const ctx = { cwd: directory, hasUI: true, ui: { notify: (message, type) => notices.push({ message, type }) } };
  await h.hooks.get('before_agent_start')({ prompt: '检查页面', systemPrompt: '' }, ctx);
  await h.commands.get('slop-check').handler('["Page.vue"]', ctx);
  assert.match(notices.at(-1).message, /取证或复核/);
  assert.equal(h.messages.at(-1).display, false);
}));
test('规则停用开关不运行审计', async () => {
  const original = process.env.TYPESAFE_ANTI_SLOP_DISABLE;
  try {
    process.env.TYPESAFE_ANTI_SLOP_DISABLE = '1';
    const h = harness(() => { throw new Error('不应调用'); });
    assert.equal(await h.hooks.get('agent_settled')({}, { cwd: tmpdir() }), undefined);
  } finally { if (original === undefined) delete process.env.TYPESAFE_ANTI_SLOP_DISABLE; else process.env.TYPESAFE_ANTI_SLOP_DISABLE = original; }
});

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL?.endsWith('/lystar-jev-guard.ts')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(candidate)) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const guard = await import('../extensions/lystar-jev-guard.ts');
test('Guard 只注册工具预检，不绑定会话压缩和 anti-ai-slop', () => {
  const handlers = new Map(); const commands = [];
  guard.default({ on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand(name) { commands.push(name); } });
  assert.equal(handlers.get('tool_call').length, 1);
  assert.equal(handlers.get('tool_result').length, 1);
  assert.equal(handlers.get('before_agent_start').length, 1);
  assert.equal(handlers.has('session_before_compact'), false);
  assert.equal(handlers.has('agent_settled'), false);
  assert.deepEqual(commands, []);
});
test('共享 API 请求沿用模型及凭据配置', async () => {
  const originalFetch = globalThis.fetch;
  const names = ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.TYPESAFE_API_KEY = 'unit-test-placeholder'; process.env.TYPESAFE_BASE_URL = 'https://unit.invalid/'; process.env.TYPESAFE_MODEL = 'test-model';
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://unit.invalid/v1/systemone');
      assert.equal(JSON.parse(options.body).model, 'test-model');
      return { ok: true, json: async () => ({ answers: {} }) };
    };
    await guard.requestSystemOne({ value: 1 }, {}, { timeoutMs: 100 });
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
