import { implementationRoot } from './anti-slop/setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveApiKey } from '../extensions/typesafe-core.mjs';
import { shouldPreflight } from '../extensions/lystar-jev-guard.ts';
import { candidateInput, createReviewController } from '../extensions/lystar-jev-anti-slop/anti-slop.mjs';

function restoreEnv(t, names) {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

test('测试目录按当前平台用户目录隔离，动态导入使用 file URL', async () => {
  assert.equal(homedir(), process.env.HOME);
  if (process.platform === 'win32') assert.equal(homedir(), process.env.USERPROFILE);
  assert.equal(new URL(implementationRoot).protocol, 'file:');
  const core = await import(implementationRoot + '/anti-slop.mjs');
  assert.equal(core.RULES_PATH, join(homedir(), '.agents/skills/anti-ai-slop/rules.json'));
});

test('密钥文件路径支持中文和空格', t => {
  restoreEnv(t, ['TYPESAFE_API_KEY', 'TYPESAFE_API_KEY_FILE']);
  delete process.env.TYPESAFE_API_KEY;
  const directory = join(homedir(), '扩展配置 含空格');
  mkdirSync(directory);
  const path = join(directory, 'typesafe-api-key');
  writeFileSync(path, 'unit-test-placeholder\n');
  process.env.TYPESAFE_API_KEY_FILE = path;
  assert.equal(resolveApiKey(), 'unit-test-placeholder');
});

test('PowerShell 调用进入预检，CRLF 文件保留准确修改行号', () => {
  assert.equal(shouldPreflight('powershell', { command: 'Get-Content ./说明.txt' }), true);
  const candidate = candidateInput({ path: join(homedir(), '说明 文档.txt'), before: '保留\r\n原内容\r\n末行', after: '保留\r\n新内容\r\n末行' }, 'windows-change');
  assert.deepEqual(candidate.change.ranges, [{ startLine: 2, endLine: 2 }]);
  assert.equal(candidate.change.before, '原内容\r');
  assert.equal(candidate.change.after, '新内容\r');
});

test('Windows 不把当前盘符下的 tmp 目录当作系统临时目录', { skip: process.platform !== 'win32' }, async () => {
  const cwd = homedir();
  const path = resolve('/tmp', '正式文档.txt');
  const child = relative(tmpdir(), path);
  assert.ok(isAbsolute(child) || child === '..' || child.startsWith('..' + sep));
  const controller = createReviewController({});
  const result = await controller.beforeWrite(path, '原内容', '新内容', { cwd });
  assert.equal(result.status, 'pending');
});
