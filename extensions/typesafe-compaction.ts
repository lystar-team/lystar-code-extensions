import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveApiKey } from "./typesafe-core.mjs";
import { compactSession, defaultCompactionConfig } from "./typesafe-compaction/compaction.js";

type ContextWindowContext = {
	model?: { contextWindow?: unknown };
	getContextUsage?: () => { contextWindow?: unknown } | undefined;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	hasUI: boolean;
};

let debugEnabled = false;
let lastKnownContextWindow: number | undefined;

function debugLog(message: string): void {
	if (debugEnabled) console.error(`[typesafe-compaction] ${message}`);
}

function notify(ctx: ContextWindowContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else debugLog(message);
}

function observedContextWindow(ctx: ContextWindowContext): number | undefined {
	try {
		const direct = ctx.model?.contextWindow;
		const usage = ctx.getContextUsage?.()?.contextWindow;
		const value = direct ?? usage;
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function rememberContextWindow(ctx: ContextWindowContext): void {
	const value = observedContextWindow(ctx);
	if (value) lastKnownContextWindow = value;
}

export default function typesafeCompaction(pi: ExtensionAPI): void {
	debugEnabled = process.env.TYPESAFE_COMPACTION_DEBUG === "1";

	pi.on("before_agent_start", (_event, ctx) => {
		rememberContextWindow(ctx);
	});

	pi.on("tool_call", (_event, ctx) => {
		rememberContextWindow(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (process.env.TYPESAFE_COMPACTION_DISABLE === "1") {
			debugLog("compaction skipped: TYPESAFE_COMPACTION_DISABLE=1");
			return;
		}
		if (event.signal.aborted) {
			debugLog(`compaction skipped: signal aborted reason=${event.reason}`);
			return { cancel: true };
		}

		const apiKey = resolveApiKey();
		if (!apiKey) {
			debugLog("compaction skipped: no TypeSafe API key");
			notify(ctx, "Jev 压缩跳过：未找到 API Key，已使用原生压缩", "warning");
			return;
		}

		rememberContextWindow(ctx);
		const contextWindow = lastKnownContextWindow;
		const config = defaultCompactionConfig(apiKey, contextWindow, event.preparation.tokensBefore);
		debugLog(
			`compaction start reason=${event.reason} context_window=${contextWindow ?? "unknown"} ` +
			`summary_budget=${config.maxSummaryTokens} source=${config.summaryBudgetSource}`,
		);
		const outcome = await compactSession({
			branchEntries: event.branchEntries,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			fileOps: event.preparation.fileOps,
			signal: event.signal,
			config,
		});

		if ("fallback" in outcome) {
			const message = `Jev 压缩回退：${outcome.fallback}`;
			debugLog(`${message} context_window=${contextWindow ?? "unknown"} budget=${config.maxSummaryTokens}`);
			notify(ctx, message, "warning");
			return;
		}

		debugLog(outcome.report);
		notify(ctx, outcome.report, "info");
		return {
			compaction: {
				summary: outcome.summary,
				firstKeptEntryId: outcome.firstKeptEntryId,
				tokensBefore: outcome.tokensBefore,
				usage: outcome.usage,
				details: outcome.details,
			},
		};
	});
}
