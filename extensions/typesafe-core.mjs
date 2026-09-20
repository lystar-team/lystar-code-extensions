import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev-1.13.0';
export const DEFAULT_REQUEST_TIMEOUT_MS = 1800;

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

export async function requestTypeSafe({ state, questions, signal, timeoutMs }) {
  const apiKey = resolveApiKey();
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
    const response = await fetch(`${typeSafeBaseUrl()}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: typeSafeModel(), questions }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
