import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envNumber, requestTypeSafe } from "./typesafe-core.mjs";
import { registerAntiSlop } from "./typesafe-anti-slop/anti-slop.mjs";

export default function typesafeAntiSlop(pi: ExtensionAPI): void {
	registerAntiSlop(
		pi,
		(state: unknown, questions: Record<string, unknown>, options: { signal?: AbortSignal } = {}) =>
			requestTypeSafe({
				state,
				questions,
				signal: options.signal,
				timeoutMs: envNumber("TYPESAFE_ANTI_SLOP_TIMEOUT_MS", 8000),
			}),
	);
}
