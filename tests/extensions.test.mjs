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

test('四个 Extension 都能独立加载并注册各自事件', async () => {
  const guard = await import('../extensions/typesafe-guard.ts');
  const compaction = await import('../extensions/typesafe-compaction.ts');
  const planner = await import('../extensions/typesafe-skill-planner.ts');
  const antiSlop = await import('../extensions/typesafe-anti-slop.ts');
  const guardEvents = new Map();
  const compactionEvents = new Map();
  const plannerEvents = new Map();
  const antiSlopEvents = new Map();
  const makePi = events => ({
    on(name, handler) { events.set(name, handler); },
    registerCommand(name) { events.set(`command:${name}`, true); },
  });
  guard.default(makePi(guardEvents));
  compaction.default(makePi(compactionEvents));
  planner.default(makePi(plannerEvents));
  antiSlop.default(makePi(antiSlopEvents));
  assert.equal(typeof guardEvents.get('tool_call'), 'function');
  assert.equal(typeof guardEvents.get('tool_result'), 'function');
  assert.equal(guardEvents.has('session_before_compact'), false);
  assert.equal(typeof compactionEvents.get('session_before_compact'), 'function');
  assert.equal(typeof plannerEvents.get('before_agent_start'), 'function');
  assert.equal(typeof antiSlopEvents.get('agent_settled'), 'function');
  assert.equal(antiSlopEvents.get('command:slop-check'), true);
});
