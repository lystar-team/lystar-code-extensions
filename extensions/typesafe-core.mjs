import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev-1.13.0';
export const DEFAULT_REQUEST_TIMEOUT_MS = 1800;

// Jev 单次请求的输入预算。实测 30 个片段 / 93KB / 62649 输入 Token 返回 200，
// 40 个片段 / 123KB 返回 400 max_tokens_exceeded，据此取安全上限。
export const DEFAULT_REQUEST_CHARS = 64 * 1024;
export const DEFAULT_REQUEST_TOKENS = 40_000;
// 单轮允许的 Jev 请求数上限，防止改动量大时把请求数放大到几十次。
export const DEFAULT_REQUESTS_PER_ROUND = 20;

const DEFAULT_KEY_FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'lystar-code',
  'typesafe-api-key',
);

export function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function typeSafeBaseUrl() {
  return (process.env.TYPESAFE_BASE_URL || DEFAULT_API_URL).replace(/\/$/, '');
}

export function typeSafeModel() {
  return process.env.TYPESAFE_MODEL || process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL;
}

// 所有 Extension 共用的 Jev 预算事实源：请求体大小、请求 Token、每轮请求数。
export function jevBudget() {
  return {
    requestChars: envNumber('TYPESAFE_REQUEST_CHARS', DEFAULT_REQUEST_CHARS),
    requestTokens: envNumber('TYPESAFE_REQUEST_TOKENS', DEFAULT_REQUEST_TOKENS),
    requestsPerRound: envNumber('TYPESAFE_REQUESTS_PER_ROUND', DEFAULT_REQUESTS_PER_ROUND),
  };
}

export function resolveApiKey() {
  const environmentKey = process.env.TYPESAFE_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  const keyFile = process.env.TYPESAFE_API_KEY_FILE || DEFAULT_KEY_FILE;
  try {
    const mode = statSync(keyFile).mode & 0o777;
    if (mode & 0o077 && process.env.TYPESAFE_DEBUG === '1') {
      console.error(`[typesafe-core] key file permissions are broader than 600: ${keyFile}`);
    }
    const fileKey = readFileSync(keyFile, 'utf8').trim();
    return fileKey || undefined;
  } catch {
    return undefined;
  }
}

let requestCount = 0;

export function typeSafeRequestCount() {
  return requestCount;
}

export async function requestTypeSafe({ state, questions, signal, timeoutMs, apiKey: providedApiKey, baseUrl, model }) {
  const apiKey = providedApiKey || resolveApiKey();
  if (!apiKey) throw new Error('TYPESAFE_API_KEY and the user key file are not set');

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    abort,
    timeoutMs ?? envNumber('TYPESAFE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
  );

  try {
    requestCount += 1;
    const response = await fetch(`${(baseUrl || typeSafeBaseUrl()).replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: model || typeSafeModel(), questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const reason = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new Error(`TypeSafe HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
