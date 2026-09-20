import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL,
  typeSafeBaseUrl,
  typeSafeModel,
} from '../extensions/typesafe-core.mjs';

test('共享配置使用统一的模型和地址优先级', () => {
  const previous = {
    base: process.env.TYPESAFE_BASE_URL,
    model: process.env.TYPESAFE_MODEL,
    defaultModel: process.env.TYPESAFE_DEFAULT_MODEL,
  };
  try {
    process.env.TYPESAFE_BASE_URL = 'https://example.test/';
    process.env.TYPESAFE_MODEL = 'custom-model';
    process.env.TYPESAFE_DEFAULT_MODEL = 'fallback-model';
    assert.equal(typeSafeBaseUrl(), 'https://example.test');
    assert.equal(typeSafeModel(), 'custom-model');
    delete process.env.TYPESAFE_MODEL;
    assert.equal(typeSafeModel(), 'fallback-model');
    delete process.env.TYPESAFE_DEFAULT_MODEL;
    assert.equal(typeSafeModel(), DEFAULT_MODEL);
  } finally {
    if (previous.base === undefined) delete process.env.TYPESAFE_BASE_URL;
    else process.env.TYPESAFE_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.TYPESAFE_MODEL;
    else process.env.TYPESAFE_MODEL = previous.model;
    if (previous.defaultModel === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL;
    else process.env.TYPESAFE_DEFAULT_MODEL = previous.defaultModel;
  }
});

test('共享客户端保留失败响应的原因', async () => {
  const { requestTypeSafe } = await import('../extensions/typesafe-core.mjs');
  const previousKey = process.env.TYPESAFE_API_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.TYPESAFE_API_KEY = 'unit-test-key';
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => '{"detail":{"error_type":"max_tokens_exceeded"}}',
    });
    await assert.rejects(
      () => requestTypeSafe({ state: {}, questions: {}, timeoutMs: 100 }),
      /TypeSafe HTTP 400: .*max_tokens_exceeded/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test('共享客户端发送统一的模型、问题和请求地址', async () => {
  const { requestTypeSafe } = await import('../extensions/typesafe-core.mjs');
  const previous = {
    key: process.env.TYPESAFE_API_KEY,
    base: process.env.TYPESAFE_BASE_URL,
    model: process.env.TYPESAFE_MODEL,
  };
  const originalFetch = globalThis.fetch;
  try {
    process.env.TYPESAFE_API_KEY = 'unit-test-key';
    process.env.TYPESAFE_BASE_URL = 'https://example.test/';
    process.env.TYPESAFE_MODEL = 'unit-test-model';
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://example.test/v1/systemone');
      assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
      assert.deepEqual(JSON.parse(options.body), {
        state: { request: 'test' },
        model: 'unit-test-model',
        questions: { answer: { type: 'noul' } },
      });
      return { ok: true, json: async () => ({ answers: {} }) };
    };
    await requestTypeSafe({
      state: { request: 'test' },
      questions: { answer: { type: 'noul' } },
      timeoutMs: 100,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous.key;
    if (previous.base === undefined) delete process.env.TYPESAFE_BASE_URL;
    else process.env.TYPESAFE_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.TYPESAFE_MODEL;
    else process.env.TYPESAFE_MODEL = previous.model;
  }
});
