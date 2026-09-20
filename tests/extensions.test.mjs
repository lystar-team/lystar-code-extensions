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

test('两个公开 Extension 都能加载并注册事件', async () => {
  const guard = await import('../extensions/typesafe-guard.ts');
  const planner = await import('../extensions/typesafe-skill-planner.ts');
  const guardEvents = new Map();
  const plannerEvents = new Map();
  const makePi = events => ({
    on(name, handler) { events.set(name, handler); },
    registerCommand(name) { events.set(`command:${name}`, true); },
  });
  guard.default(makePi(guardEvents));
  planner.default(makePi(plannerEvents));
  assert.equal(typeof guardEvents.get('tool_call'), 'function');
  assert.equal(typeof guardEvents.get('session_before_compact'), 'function');
  assert.equal(typeof guardEvents.get('agent_settled'), 'function');
  assert.equal(typeof plannerEvents.get('before_agent_start'), 'function');
  assert.equal(guardEvents.get('command:slop-check'), true);
});
