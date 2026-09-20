import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/extensions/')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { compactSession, estimateTokens } = await import('../extensions/lystar-jev-compaction/compaction.ts');

function message(id, role, content) {
  return { type: 'message', id, message: { role, content } };
}

function assistantTool(id, toolId, tool, input) {
  return message(id, 'assistant', [{ type: 'toolCall', id: toolId, name: tool, arguments: input }]);
}

function toolResult(id, toolId, toolName, text, isError = false) {
  return message(id, 'toolResult', [{ type: 'text', text }], {
    toolCallId: toolId,
    toolName,
    isError,
  });
}

function resultEntry(id, toolId, toolName, text, isError = false) {
  return {
    type: 'message',
    id,
    message: {
      role: 'toolResult',
      toolCallId: toolId,
      toolName,
      content: [{ type: 'text', text }],
      isError,
    },
  };
}

function config() {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.test',
    keepThreshold: 0.5,
    maxStateTokens: 4000,
    maxRequestTokens: 12000,
    truncateHeadChars: 120,
    minOldReduction: 0,
    maxSummaryTokens: 4000,
    summaryBudgetSource: 'configured',
    timeoutMs: 100,
  };
}

function params(branchEntries, firstKeptEntryId) {
  const keptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  const previousCompaction = [...branchEntries].reverse().find((entry) => entry.type === 'compaction');
  return {
    branchEntries,
    preparation: {
      firstKeptEntryId,
      messagesToSummarize: branchEntries
        .slice(0, Math.max(0, keptIndex))
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message),
      turnPrefixMessages: [],
      previousSummary: previousCompaction?.summary,
      tokensBefore: 6000,
      fileOps: { readFiles: ['src/main.ts'], modifiedFiles: ['src/main.ts'] },
    },
    signal: new AbortController().signal,
    config: config(),
  };
}

test('整段历史都在保留窗口内时说明原因，不报回退', async () => {
  const branch = [message('u1', 'user', '你好')];
  const outcome = await compactSession(params(branch, 'u1'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.notice, 'empty');
  assert.match(outcome.fallback, /保留窗口/);
  assert.doesNotMatch(outcome.fallback, /[A-Za-z]/);
});

test('用户取消压缩不提示', async () => {
  const branch = [message('u1', 'user', '开始批量处理')];
  branch.push(assistantTool('a1', 'tool-1', 'bash', { command: 'ls' }));
  branch.push(resultEntry('r1', 'tool-1', 'bash', 'ok'));
  branch.push(message('u2', 'user', '继续'));
  const aborted = params(branch, 'u2');
  const controller = new AbortController();
  controller.abort();
  aborted.signal = controller.signal;
  const outcome = await compactSession(aborted);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.notice, 'cancelled');
});

test('Compaction 使用候选清单并默认只发送一个 Jev 请求', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          answers: {
            call_t1: { type: 'noul', noul: 0.1 },
            result_t1: { type: 'noul', noul: 0.1 },
          },
          usage: { input_tokens: 80, output_tokens: 4 },
        }),
      };
    };
    const hugeResult = 'important output '.repeat(5000);
    const branch = [
      message('u1', 'user', '修复启动流程'),
      assistantTool('a1', 'tool-1', 'bash', { command: 'npm run check' }),
      resultEntry('r1', 'tool-1', 'bash', hugeResult),
      message('u2', 'user', '继续处理剩余问题'),
    ];
    const outcome = await compactSession(params(branch, 'u2'));
    assert.equal(outcome.ok, true);
    assert.equal(requests.length, 1);
    assert.ok(JSON.stringify(requests[0].state).length < hugeResult.length / 4);
    assert.match(outcome.report, /1 个请求/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('候选过多时按预算分批，状态只拟合一次并在请求间共享', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.1 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const branch = [message('u0', 'user', '保留当前任务目标')];
    for (let index = 0; index < 30; index++) {
      const toolId = `tool-${index}`;
      branch.push(assistantTool(`a${index}`, toolId, 'bash', { command: `cmd ${index}` }));
      branch.push(resultEntry(`r${index}`, toolId, 'bash', 'ok'));
    }
    branch.push(message('uk', 'user', '继续处理'));
    const input = params(branch, 'uk');
    input.config = { ...config(), maxStateTokens: 2000, maxRequestTokens: 2000 };
    const outcome = await compactSession(input);
    assert.equal(outcome.ok, true);
    assert.ok(requests.length > 1, '问题超出请求预算时仍要分批');
    const states = requests.map((request) => request.state.conversation);
    assert.equal(new Set(states).size, 1, '状态只拟合一次，所有请求共享同一份');
    const asked = new Set(requests.flatMap((request) => Object.keys(request.questions)));
    assert.equal(asked.size, 60, '每个候选都要被问到一次');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('超大工具结果不进入状态文本，状态拟合不随历史体积膨胀', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.4 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const branch = [message('u0', 'user', '保留当前任务目标')];
    for (let index = 0; index < 150; index++) {
      const toolId = `tool-${index}`;
      branch.push(assistantTool(`a${index}`, toolId, 'bash', { command: `npm run check -- --scope ${index}` }));
      branch.push(resultEntry(`r${index}`, toolId, 'bash', `日志 ${index} `.repeat(1000)));
    }
    branch.push(message('uk', 'user', '继续处理'));
    const input = params(branch, 'uk');
    input.config = { ...config(), maxStateTokens: 20000, maxSummaryTokens: 64000 };
    const outcome = await compactSession(input);
    assert.equal(outcome.ok, true);
    const states = requests.map((request) => request.state.conversation);
    assert.ok(states.length >= 1);
    assert.ok(states[0].length < 60_000, `状态不应包含完整结果正文，实际 ${states[0].length}`);
    assert.doesNotMatch(states[0], /日志 0(?: 日志 0){200}/);
    assert.match(outcome.report, /状态拟合 (?:head4000|head1000|meta|compact|minimal)/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('问题正文计入请求预算，实际发送的请求体不超预算', async () => {
  const previousFetch = globalThis.fetch;
  const bodies = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.9 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const branch = [message('u1', 'user', '开始批量处理')];
    for (let index = 0; index < 120; index += 1) {
      branch.push(assistantTool(`a${index}`, `tool-${index}`, 'bash', { command: `step ${index}` }));
      branch.push(resultEntry(`r${index}`, `tool-${index}`, 'bash', `output ${index} `.repeat(30)));
    }
    branch.push(message('u2', 'user', '继续'));
    const budgeted = params(branch, 'u2');
    budgeted.config.maxStateTokens = 6000;
    budgeted.config.maxRequestTokens = 12000;
    budgeted.config.maxSummaryTokens = 40000;
    const outcome = await compactSession(budgeted);
    assert.equal(outcome.ok, true);
    assert(bodies.length > 1, '问题超出预算时必须分批');
    const oversize = bodies
      .map((body) => estimateTokens(JSON.stringify({ state: body.state, questions: body.questions })) - budgeted.config.maxRequestTokens)
      .filter((over) => over > 0);
    assert.deepEqual(oversize, [], '每个请求体都要落在请求预算内');
    assert.equal(outcome.details.fastJev.requests, bodies.length);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('状态挤不进上限时按调用数封顶，只对状态里的调用提问', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.9 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const branch = [message('u1', 'user', '开始批量处理')];
    for (let index = 0; index < 600; index += 1) {
      const command = index < 300 ? `legacy-${index}` : `recent-${index}`;
      branch.push(assistantTool(`a${index}`, `tool-${index}`, 'bash', { command }));
      branch.push(resultEntry(`r${index}`, `tool-${index}`, 'bash', `output ${index} `.repeat(20)));
    }
    branch.push(message('u2', 'user', '继续'));
    const oversized = params(branch, 'u2');
    oversized.config.maxStateTokens = 8000;
    oversized.config.maxSummaryTokens = 40000;
    const outcome = await compactSession(oversized);
    assert.equal(outcome.ok, true);
    assert.match(outcome.report, /状态拟合 minimal_bounded/);
    const questions = Object.keys(requests[0].questions);
    assert(questions.length <= 400, '只对状态里渲染出来的调用提问');
    const state = JSON.stringify(requests[0].state);
    assert.match(state, /recent-599/);
    assert.doesNotMatch(state, /legacy-1"/);
    assert.match(state, /earlier tool calls not shown/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('摘要压不进预算时只保留最近一段旧消息的细节', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.9 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const branch = [message('u1', 'user', '开始批量处理')];
    for (let index = 0; index < 400; index += 1) {
      branch.push(assistantTool(`a${index}`, `tool-${index}`, 'bash', { command: `step ${index}` }));
      branch.push(resultEntry(`r${index}`, `tool-${index}`, 'bash', `output ${index} `.repeat(20)));
    }
    branch.push(message('u2', 'user', '继续'));
    const cramped = params(branch, 'u2');
    cramped.config.maxStateTokens = 8000;
    cramped.config.maxSummaryTokens = 5000;
    const outcome = await compactSession(cramped);
    assert.equal(outcome.ok, true);
    assert.match(outcome.report, /摘要拟合 bounded/);
    assert.match(outcome.summary, /earlier messages: \d+ tool calls/);
    assert.match(outcome.summary, /Earlier user messages/);
    assert.match(outcome.summary, /开始批量处理/);
    assert.doesNotMatch(outcome.summary, /step 1\b/);
    assert(estimateTokens(outcome.summary) <= cramped.config.maxSummaryTokens, '摘要必须落在预算内');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('重复压缩使用 Pi preparation 中的旧消息，不丢上一轮保留边界', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.1 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const branch = [
      message('kept-from-previous', 'user', '上一轮保留的迁移目标仍然有效'),
      { type: 'compaction', id: 'c1', summary: '上一轮摘要：已经完成基础摸底。', firstKeptEntryId: 'kept-from-previous' },
      message('old-user', 'user', '继续处理迁移校验'),
      assistantTool('a1', 'tool-1', 'bash', { command: 'npm run check' }),
      resultEntry('r1', 'tool-1', 'bash', 'check passed'),
      message('kept-now', 'user', '保留当前任务'),
    ];
    const outcome = await compactSession(params(branch, 'kept-now'));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.details.fastJev.oldMessages, 4);
    assert.match(outcome.summary, /上一轮保留的迁移目标仍然有效/);
    assert.equal(outcome.summary.match(/上一轮摘要：已经完成基础摸底。/g)?.length, 1);
    assert.doesNotMatch(outcome.summary, /Previous compaction summary/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('受保护写操作在紧凑档位保留路径与入参开头', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.9 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const payload = 'x'.repeat(8000);
    const branch = [
      message('u1', 'user', '开始'),
      assistantTool('a1', 'tool-1', 'edit', { path: 'src/app.ts', oldText: payload, newText: payload }),
      resultEntry('r1', 'tool-1', 'edit', 'ok'),
      message('u2', 'user', '继续'),
    ];
    const cramped = params(branch, 'u2');
    cramped.config.maxSummaryTokens = 800;
    const outcome = await compactSession(cramped);
    assert.equal(outcome.ok, true);
    assert.match(outcome.summary, /src\/app\.ts/);
    assert.doesNotMatch(outcome.summary, /x{2000}/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('二次 Compaction 使用旧摘要作为基线，不把旧摘要嵌套成历史消息', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const answers = {};
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.1 };
      return { ok: true, json: async () => ({ answers }) };
    };
    const branch = [
      { type: 'compaction', id: 'c1', summary: '稳定事实：入口文件已经完成初始化。', firstKeptEntryId: 'u1' },
      message('u1', 'user', '继续修复配置'),
      assistantTool('a1', 'tool-1', 'bash', { command: 'npm run typecheck' }),
      resultEntry('r1', 'tool-1', 'bash', 'typecheck passed'),
      message('u2', 'user', '保留当前任务'),
    ];
    const outcome = await compactSession(params(branch, 'u2'));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.summary.match(/稳定事实：入口文件已经完成初始化。/g)?.length, 1);
    assert.doesNotMatch(outcome.summary, /Previous compaction summary/);
    assert.equal(outcome.details.fastJev.previousSummaryMerged, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
