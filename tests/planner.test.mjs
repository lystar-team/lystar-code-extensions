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

const planner = await import('../extensions/lystar-jev-skill-planner.ts');

const SKILLS = [
  { name: 'ui-design', description: '前端可见界面的设计、修改与评审', disableModelInvocation: false },
  { name: 'yean-develop-style', description: '软件开发实现与代码评审纪律', disableModelInvocation: false },
];

function installMock() {
  const bodies = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    const answers = {};
    for (const key of Object.keys(body.questions ?? {})) {
      answers[key] = key === 'response_mode'
        ? { type: 'choice', choice: 'implementation_report' }
        : { type: 'noul', noul: 0.9 };
    }
    return { ok: true, json: async () => ({ answers, usage: { input_tokens: 10, output_tokens: 2 } }) };
  };
  return { bodies, restore: () => { globalThis.fetch = previous; } };
}

async function runPrompts(prompts, skills = SKILLS) {
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  const handlers = new Map();
  planner.default({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {} });
  const { bodies, restore } = installMock();
  const ctx = {
    cwd: '/repo',
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getBranch: () => [], getLeafId: () => 'leaf-1' },
    model: { contextWindow: 200000 },
  };
  const injected = [];
  try {
    await handlers.get('session_start')({ type: 'session_start', reason: 'new' }, ctx);
    for (const prompt of prompts) {
      const result = await handlers.get('before_agent_start')({
        type: 'before_agent_start',
        prompt,
        images: undefined,
        systemPrompt: 'BASE',
        systemPromptOptions: { cwd: '/repo', skills },
      }, ctx);
      injected.push(result.systemPrompt);
    }
  } finally {
    restore();
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
  return { bodies, injected };
}

test('显式 Skill 请求复用已缓存的计划', async () => {
  const { bodies, injected } = await runPrompts(Array(10).fill('请按 <skill name="ui-design"> 处理这个界面'));
  assert.equal(bodies.length, 2, '同一显式请求只应在前两次询问 Jev');
  assert.equal(injected[2], injected[9], '缓存命中后注入的指导必须一致');
  assert.match(injected[0], /<jev_skill_plan skills="ui-design"/);
  assert.equal(bodies[0].state.availableSkills.length, 0, '显式路径不发送 Skill 候选列表');
});

test('显式 Skill 稳定后命中缓存，切换技能时重新询问', async () => {
  const { bodies, injected } = await runPrompts([
    '请按 <skill name="ui-design"> 处理这个界面',
    '请按 <skill name="ui-design"> 处理这个界面',
    '请按 <skill name="ui-design"> 处理这个界面',
    '请按 <skill name="yean-develop-style"> 评审这段代码',
    '请按 <skill name="yean-develop-style"> 评审这段代码',
    '请按 <skill name="yean-develop-style"> 评审这段代码',
  ]);
  assert.equal(bodies.length, 4, '每个显式请求只应在首次出现时询问 Jev');
  assert.equal(injected[1], injected[2]);
  assert.match(injected[2], /skills="ui-design"/);
  assert.match(injected[5], /skills="yean-develop-style"/);
  assert.notEqual(injected[2], injected[5], '切换 Skill 后不能沿用上一份指导');
});

test('非显式请求仍按请求指纹复用计划', async () => {
  const { bodies, injected } = await runPrompts(Array(10).fill('请修复启动流程并补充测试'));
  assert.equal(bodies.length, 2, '同一请求只应在前两次询问 Jev');
  assert.equal(injected[2], injected[9]);
});

test('没有可用 Skill 时不询问 Jev', async () => {
  const { bodies, injected } = await runPrompts(Array(10).fill('普通问题'), []);
  assert.equal(bodies.length, 0);
  assert.match(injected[0], /<jev_skill_plan skills="none"/);
});
