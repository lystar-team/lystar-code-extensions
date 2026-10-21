declare module '*.mjs' {
  export function envNumber(name: string, fallback: number): number;
  export function requestTypeSafe(options: Record<string, unknown>): Promise<unknown>;
  export function typeSafeRequestCount(): number;
  export function jevBudget(): { requestChars: number; requestTokens: number; requestsPerRound: number };
  export function resolveApiKey(): string | undefined;
  export function typeSafeBaseUrl(): string;
  export function typeSafeModel(): string;
  export const RULES_PATH: string;
  export function createReviewController(pi: unknown, options?: Record<string, unknown>): any;
  export function formatAuditOutput(results: any): any;
  export function decodeSource(bytes: Uint8Array): string | undefined;
}
