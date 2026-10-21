import './anti-slop/setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAntiSlop } from '../extensions/lystar-jev-anti-slop.ts';

function harness() {
  const tools = new Map();
  const events = new Map();
  let requests = 0;
  const registration = registerAntiSlop({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name, handler) { events.set(name, handler); },
  }, { ask: async () => { requests++; return { review: { verdict: 'allow', findings: [], neededEvidence: [], patches: [] } }; } });
  return { ...registration, tools, events, requests: () => requests };
}

test('同会话按 inputId 隔离审查，不注册自动续轮钩子', () => {
  const h = harness();
  const ctx = { sessionManager: {}, currentTurn: { inputId: 'first' } };
  const first = h.controller(ctx);
  ctx.currentTurn.inputId = 'second';
  assert.notEqual(h.controller(ctx), first);
  ctx.currentTurn.inputId = 'first';
  assert.equal(h.controller(ctx), first);
  assert.equal(h.events.has('agent_settled'), false);
  assert.deepEqual([...h.tools.keys()], ['read', 'edit', 'write', 'slop_check']);
});

test('缺少 inputId 时明确返回未检查', async () => {
  const h = harness();
  const results = await h.controller({ sessionManager: {} }).finalAudit();
  assert.equal(results[0].failureReason, 'missing_input_id');
  assert.equal(h.requests(), 0);
});

test('原生写入代理记录成功修改，显式复核才请求审查', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'slop-entry-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = harness();
  const ctx = { cwd, currentTurn: { inputId: 'write-turn' }, sessionManager: { getBranch: () => [] } };
  const path = join(cwd, 'note.txt');
  await h.tools.get('write').execute('write', { path, content: '已合入的扩展' }, undefined, undefined, ctx);
  assert.equal(readFileSync(path, 'utf8'), '已合入的扩展');
  assert.equal(h.requests(), 0);
  const result = await h.tools.get('slop_check').execute('audit', {}, undefined, undefined, ctx);
  assert.equal(result.details.decision.nextAction, 'finish');
  assert.equal(h.requests(), 1);
});
