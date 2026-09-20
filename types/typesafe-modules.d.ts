declare module '*.mjs' {
  export function envNumber(name: string, fallback: number): number;
  export function requestTypeSafe(options: Record<string, unknown>): Promise<unknown>;
  export function resolveApiKey(): string | undefined;
  export function typeSafeBaseUrl(): string;
  export function typeSafeModel(): string;
  export function registerAntiSlop(
    pi: unknown,
    ask: unknown,
    options?: Record<string, unknown>,
  ): void;
}
