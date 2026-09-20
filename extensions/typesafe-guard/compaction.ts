import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { typeSafeBaseUrl, typeSafeModel } from "../typesafe-core.mjs";

type Role = "user" | "assistant";

type ToolUse = {
	tool_use_id: string;
	tool: string;
	input: unknown;
};

type ToolResult = {
	tool_use_id: string;
	toolName: string;
	text: string;
	isError: boolean;
};

type InternalMessage = {
	role: Role;
	text: string;
	thinking: string;
	toolUses: ToolUse[];
	toolResults: ToolResult[];
};

type Transcript = {
	messages: InternalMessage[];
	oldCount: number;
};

type ToolCandidate = {
	id: string;
	toolUseId: string;
	tool: string;
	input: unknown;
	result: ToolResult | undefined;
	callMessageIndex: number;
	resultMessageIndex: number;
	pinned: boolean;
	protectedCall: boolean;
};

type Answer = {
	keepCall: number;
	keepResult: number;
};

type Decision = {
	id: string;
	tool: string;
	action: "keep" | "drop_result" | "drop_call";
	reason: string;
	keepCall: number;
	keepResult: number;
};

type CompactionConfig = {
	apiKey: string;
	model: string;
	baseUrl: string;
	keepThreshold: number;
	maxStateTokens: number;
	maxRequestTokens: number;
	truncateHeadChars: number;
	minOldReduction: number;
	maxSummaryTokens: number;
	summaryBudgetSource: "configured" | "context_window" | "tokens_before" | "conservative_default";
	contextWindow?: number;
	timeoutMs: number;
};

type CompactionUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

type Success = {
	ok: true;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	usage?: CompactionUsage;
	details: Record<string, unknown>;
	report: string;
};

type Fallback = {
	ok: false;
	fallback: string;
};

type StateFit = {
	text: string;
	tokens: number;
	stage: string;
};

type ResultFitMode = "normal" | "head" | "minimal";
type SummaryFitMode = ResultFitMode | "compact" | "skeleton" | "outline";

type JevResponse = {
	model?: string;
	answers?: Record<string, { type?: string; noul?: number }>;
	usage?: { input_tokens?: number; output_tokens?: number };
};

const DEFAULT_STATE_TOKENS = 20_000;
const DEFAULT_REQUEST_TOKENS = 30_000;
const DEFAULT_SUMMARY_TOKENS = 16_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_TRUNCATE_HEAD_CHARS = 300;
const DEFAULT_MIN_REDUCTION = 0.25;
const REQUEST_OVERHEAD_TOKENS = 64;
const SUMMARY_HEADER =
	"<typesafe-jev-compaction>\n" +
	"Earlier history is preserved as a deterministic transcript. Jev removed or truncated stale tool calls/results; when the summary budget requires it, older non-error narrative is abridged. User goals, protected failures, protected writes, and kept content remain represented.\n" +
	"</typesafe-jev-compaction>";

function finiteEnv(name: string, fallback: number, min = 1): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value >= min ? value : fallback;
}

function redact(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, "$1[REDACTED]")
		.replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
		.replace(/apikey_[A-Za-z0-9_]+/g, "[REDACTED]");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable input]";
	}
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	let omittedImages = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const item = part as { type?: unknown; text?: unknown };
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		else if (item.type === "image") omittedImages += 1;
	}
	if (omittedImages > 0) parts.push(`[${omittedImages} image${omittedImages === 1 ? "" : "s"} omitted]`);
	return parts.join("\n");
}

function assistantContent(content: unknown): Pick<InternalMessage, "text" | "thinking" | "toolUses"> {
	let text = "";
	let thinking = "";
	const toolUses: ToolUse[] = [];
	if (!Array.isArray(content)) return { text, thinking, toolUses };
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			text = text ? `${text}\n${block.text}` : block.text;
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			thinking = thinking ? `${thinking}\n${block.thinking}` : block.thinking;
		} else if (block.type === "toolCall") {
			const id = typeof block.id === "string" ? block.id : "";
			const name = typeof block.name === "string" ? block.name : "tool";
			if (id) toolUses.push({ tool_use_id: id, tool: name, input: block.arguments });
		}
	}
	return { text, thinking, toolUses };
}

function messageFromEntry(entry: SessionEntry): InternalMessage | undefined {
	if (entry.type === "compaction") {
		return {
			role: "user",
			text: `Previous compaction summary:\n\n${entry.summary}`,
			thinking: "",
			toolUses: [],
			toolResults: [],
		};
	}
	if (entry.type === "branch_summary") {
		return {
			role: "user",
			text: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${entry.summary}\n</summary>`,
			thinking: "",
			toolUses: [],
			toolResults: [],
		};
	}
	if (entry.type === "custom_message") {
		return {
			role: "user",
			text: textFromContent(entry.content),
			thinking: "",
			toolUses: [],
			toolResults: [],
		};
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as unknown as Record<string, unknown>;
	const role = message.role;
	if (role === "user") {
		return {
			role: "user",
			text: textFromContent(message.content),
			thinking: "",
			toolUses: [],
			toolResults: [],
		};
	}
	if (role === "assistant") {
		const parsed = assistantContent(message.content);
		return { role: "assistant", ...parsed, toolResults: [] };
	}
	if (role === "toolResult") {
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		if (!toolCallId) return undefined;
		return {
			role: "user",
			text: "",
			thinking: "",
			toolUses: [],
			toolResults: [
				{
					tool_use_id: toolCallId,
					toolName: typeof message.toolName === "string" ? message.toolName : "tool",
					text: textFromContent(message.content),
					isError: message.isError === true,
				},
			],
		};
	}
	if (role === "bashExecution") {
		const command = typeof message.command === "string" ? message.command : "";
		const output = typeof message.output === "string" ? message.output : "";
		if (message.excludeFromContext === true) return undefined;
		let text = `Ran \`${command}\`\n`;
		text += output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)";
		if (message.cancelled === true) text += "\n\n(command cancelled)";
		if (typeof message.exitCode === "number" && message.exitCode !== 0) {
			text += `\n\nCommand exited with code ${message.exitCode}`;
		}
		if (message.truncated === true && typeof message.fullOutputPath === "string") {
			text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
		}
		return { role: "user", text, thinking: "", toolUses: [], toolResults: [] };
	}
	if (role === "custom") {
		return { role: "user", text: textFromContent(message.content), thinking: "", toolUses: [], toolResults: [] };
	}
	return undefined;
}

function convertBranch(branchEntries: readonly SessionEntry[], firstKeptEntryId: string): Transcript | undefined {
	const keptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (keptIndex < 0) return undefined;
	const messages: InternalMessage[] = [];
	let oldCount = 0;
	for (let index = 0; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (!entry) continue;
		const message = messageFromEntry(entry);
		if (!message) continue;
		if (!message.text && !message.thinking && message.toolUses.length === 0 && message.toolResults.length === 0) continue;
		messages.push(message);
		if (index < keptIndex) oldCount += 1;
	}
	return { messages, oldCount };
}

function compactedContextEntries(branchEntries: readonly SessionEntry[]): SessionEntry[] {
	const path = [...branchEntries];
	let compactionIndex = -1;
	for (let index = path.length - 1; index >= 0; index -= 1) {
		if (path[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex < 0) return path;

	const compaction = path[compactionIndex] as SessionEntry & { firstKeptEntryId?: string };
	const firstKeptIndex = typeof compaction.firstKeptEntryId === "string"
		? path.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
		: -1;
	const contextEntries: SessionEntry[] = [compaction];
	if (firstKeptIndex >= 0 && firstKeptIndex < compactionIndex) {
		contextEntries.push(...path.slice(firstKeptIndex, compactionIndex));
	}
	contextEntries.push(...path.slice(compactionIndex + 1));
	return contextEntries;
}

function isWriteLikeTool(tool: string): boolean {
	return /^(?:write|edit|apply_patch|patch|delete|remove|rename|move|mkdir|create)/i.test(tool);
}

function collectCalls(transcript: Transcript): ToolCandidate[] {
	const results = new Map<string, { result: ToolResult; messageIndex: number }>();
	for (let index = 0; index < transcript.messages.length; index += 1) {
		for (const result of transcript.messages[index].toolResults) {
			results.set(result.tool_use_id, { result, messageIndex: index });
		}
	}
	const calls: ToolCandidate[] = [];
	let number = 0;
	for (let messageIndex = 0; messageIndex < transcript.messages.length; messageIndex += 1) {
		const message = transcript.messages[messageIndex];
		if (message.role !== "assistant") continue;
		for (const use of message.toolUses) {
			number += 1;
			const found = results.get(use.tool_use_id);
			const result = found?.result;
			const resultMessageIndex = found?.messageIndex ?? messageIndex;
			const pinned = messageIndex >= transcript.oldCount || resultMessageIndex >= transcript.oldCount;
			const protectedCall = Boolean(result?.isError) || isWriteLikeTool(use.tool);
			calls.push({
				id: `t${number}`,
				toolUseId: use.tool_use_id,
				tool: use.tool,
				input: use.input,
				result,
				callMessageIndex: messageIndex,
				resultMessageIndex,
				pinned,
				protectedCall,
			});
		}
	}
	return calls;
}

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

function estimateTokens(text: string): number {
	let tokens = 0;
	for (const match of text.matchAll(TOKEN_PIECES)) {
		const piece = match[0];
		const first = piece.charCodeAt(0);
		if (first >= 48 && first <= 57) tokens += piece.length / 2;
		else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1 + Math.floor((piece.length - 1) / 6);
		else tokens += 0.9;
	}
	return Math.ceil(tokens);
}

function resultText(result: ToolResult, mode: "full" | "head4000" | "head1000" | "meta"): string {
	if (mode === "full") return result.text;
	if (mode === "meta") return `[${result.text.length} chars${result.isError ? ", error" : ""}; result body omitted for Jev state]`;
	const limit = mode === "head4000" ? 4000 : 1000;
	if (result.text.length <= limit) return result.text;
	return `${result.text.slice(0, limit)}\n[${result.text.length - limit} chars omitted for Jev state]`;
}

function stateText(messages: readonly InternalMessage[], mode: "full" | "head4000" | "head1000" | "meta"): string {
	const chunks: string[] = [];
	for (const message of messages) {
		const parts: string[] = [];
		if (message.role === "user" && message.text) parts.push(`[User]\n${message.text}`);
		if (message.role === "assistant") {
			if (message.thinking) parts.push(`[Assistant thinking]\n${message.thinking}`);
			if (message.text) parts.push(`[Assistant]\n${message.text}`);
			for (const use of message.toolUses) parts.push(`[Tool call ${use.tool}]\n${safeJson(use.input)}`);
		}
		for (const result of message.toolResults) {
			parts.push(`[Tool result ${result.toolName}${result.isError ? ", error" : ""}]\n${resultText(result, mode)}`);
		}
		if (parts.length > 0) chunks.push(parts.join("\n\n"));
	}
	return chunks.join("\n\n");
}

function abridge(text: string, head: number, tail: number): string {
	if (text.length <= head + tail + 40) return text;
	const suffix = tail > 0 ? `\n${text.slice(-tail)}` : "";
	return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]${suffix}`;
}

function compactStateText(messages: readonly InternalMessage[], oldCount: number, minimal: boolean): string {
	const chunks: string[] = [];
	const goals = messages
		.filter((message) => message.role === "user" && message.toolResults.length === 0 && message.text.trim().length > 0)
		.slice(-3)
		.map((message) => abridge(message.text, 500, 120));
	if (goals.length > 0) chunks.push(`[Recent goals]\n${goals.join("\n---\n")}`);
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const old = index < oldCount;
		const parts: string[] = [];
		if (minimal && old && message.toolUses.length === 0 && message.toolResults.length === 0) continue;
		if (message.role === "user" && message.text && (!minimal || !old)) {
			const limit = old ? abridge(message.text, 300, 120) : abridge(message.text, 1200, 300);
			parts.push(`[User${old ? ", old" : ", recent"}]\n${limit}`);
		}
		if (message.role === "assistant") {
			if (!old && message.thinking) parts.push(`[Assistant thinking]\n${abridge(message.thinking, 300, 120)}`);
			if (message.text && (!minimal || !old)) {
				parts.push(`[Assistant${old ? ", old" : ", recent"}]\n${abridge(message.text, old ? 220 : 1200, old ? 80 : 300)}`);
			}
			for (const use of message.toolUses) {
				const input = safeJson(use.input);
				parts.push(`[Tool call ${use.tool}]\n${abridge(input, minimal ? 80 : 240, 0)}`);
			}
		}
		for (const result of message.toolResults) {
			const body = result.isError ? abridge(result.text, 300, 100) : `${result.text.length} chars omitted`;
			parts.push(`[Tool result ${result.toolName}${result.isError ? ", error" : ""}]\n${body}`);
		}
		if (parts.length > 0) chunks.push(parts.join("\n\n"));
	}
	return chunks.join("\n\n");
}

function fitState(messages: readonly InternalMessage[], oldCount: number, maxTokens: number): StateFit {
	const stages: Array<[StateFit["stage"], Parameters<typeof stateText>[1]]> = [
		["full", "full"],
		["head4000", "head4000"],
		["head1000", "head1000"],
		["meta", "meta"],
	];
	for (const [stage, mode] of stages) {
		const text = stateText(messages, mode);
		const tokens = estimateTokens(text);
		if (tokens <= maxTokens) return { text, tokens, stage };
	}
	for (const [stage, minimal] of [["compact", false], ["minimal", true]] as const) {
		const text = compactStateText(messages, oldCount, minimal);
		const tokens = estimateTokens(text);
		if (tokens <= maxTokens) return { text, tokens, stage };
	}
	throw new Error(`Jev state exceeds ${maxTokens} tokens after staged reduction`);
}

function questionTokens(tool: ToolCandidate): number {
	return estimateTokens(JSON.stringify({
		[`call_${tool.id}`]: "keep call",
		[`result_${tool.id}`]: "keep result",
	}));
}

function batches(calls: readonly ToolCandidate[], stateTokens: number, maxRequestTokens: number): ToolCandidate[][] {
	const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
	if (budget <= 0) throw new Error("Jev state leaves no room for questions");
	const result: ToolCandidate[][] = [];
	let current: ToolCandidate[] = [];
	let used = 0;
	for (const call of calls) {
		const cost = questionTokens(call);
		if (current.length > 0 && used + cost > budget) {
			result.push(current);
			current = [];
			used = 0;
		}
		if (cost > budget) throw new Error(`Jev question for ${call.id} does not fit request budget`);
		current.push(call);
		used += cost;
	}
	if (current.length > 0) result.push(current);
	return result;
}

function noulValue(response: JevResponse, key: string): number {
	const value = response.answers?.[key]?.noul;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

async function askBatch(
	batch: readonly ToolCandidate[],
	state: string,
	config: CompactionConfig,
	signal: AbortSignal,
): Promise<{ answers: Map<string, Answer>; usage: { input: number; output: number } }> {
	const questions: Record<string, { type: "noul"; instructions: string }> = {};
	for (const call of batch) {
		questions[`call_${call.id}`] = {
			type: "noul",
			instructions: `Should the historical ${call.tool} call remain in context, including its input? Keep it if the assistant may need to know that this action was attempted, especially for errors, constraints, or later decisions.`,
		};
		questions[`result_${call.id}`] = {
			type: "noul",
			instructions: `Should the full output of historical ${call.tool} call remain verbatim? Keep it if its exact contents may be needed; otherwise it may be shortened to a head and re-run note.`,
		};
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: config.model,
				state: { conversation: redact(state) },
				questions,
			}),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
		const payload = (await response.json()) as JevResponse;
		const answers = new Map<string, Answer>();
		for (const call of batch) {
			answers.set(call.id, {
				keepCall: noulValue(payload, `call_${call.id}`),
				keepResult: noulValue(payload, `result_${call.id}`),
			});
		}
		return {
			answers,
			usage: {
				input: payload.usage?.input_tokens ?? 0,
				output: payload.usage?.output_tokens ?? 0,
			},
		};
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

function decide(call: ToolCandidate, answer: Answer | undefined, threshold: number): Decision {
	const keepCall = call.pinned || call.protectedCall ? 1 : answer?.keepCall ?? 1;
	const keepResult = call.result?.isError ? 1 : answer?.keepResult ?? 1;
	if (call.pinned) return { id: call.id, tool: call.tool, action: "keep", reason: "pinned", keepCall, keepResult };
	if (call.result?.isError) return { id: call.id, tool: call.tool, action: "keep", reason: "error_protected", keepCall, keepResult };
	if (keepResult >= threshold) return { id: call.id, tool: call.tool, action: "keep", reason: "kept", keepCall, keepResult };
	if (keepCall >= threshold) return { id: call.id, tool: call.tool, action: "drop_result", reason: "result_dropped", keepCall, keepResult };
	return { id: call.id, tool: call.tool, action: "drop_call", reason: "call_dropped", keepCall, keepResult };
}

function truncateResult(text: string, isError: boolean, headChars: number): string {
	if (text.length <= headChars + 120) return text;
	return `${headChars > 0 ? `${text.slice(0, headChars)}\n` : ""}[Jev compacted ${text.length - headChars} chars of this tool result${isError ? " (error protected)" : ""}; re-run the tool if needed]`;
}

function abridgeSummaryText(text: string, mode: SummaryFitMode, kind: "user" | "assistant" | "thinking"): string {
	if (mode === "compact") return abridge(text, kind === "thinking" ? 400 : 700, kind === "thinking" ? 100 : 180);
	if (mode === "skeleton") return abridge(text, kind === "thinking" ? 160 : 300, kind === "thinking" ? 40 : 80);
	if (mode === "outline") return abridge(text, kind === "thinking" ? 80 : 140, kind === "thinking" ? 0 : 40);
	return text;
}

function summaryInputText(input: string, mode: SummaryFitMode, protectedCall: boolean): string {
	if (protectedCall || mode === "normal" || mode === "head" || mode === "minimal") return input;
	if (mode === "compact") return abridge(input, 480, 100);
	if (mode === "skeleton") return abridge(input, 180, 40);
	return `[tool input omitted; ${input.length} chars]`;
}

function summaryResultMode(mode: SummaryFitMode): ResultFitMode {
	if (mode === "normal") return "normal";
	if (mode === "head") return "head";
	return "minimal";
}

function messageChars(message: InternalMessage): number {
	let total = message.text.length + message.thinking.length;
	for (const use of message.toolUses) total += safeJson(use.input).length;
	for (const result of message.toolResults) total += result.text.length;
	return total;
}

function summaryReduction(serialized: { charsBefore: number; charsAfter: number }): number {
	return serialized.charsBefore === 0 ? 0 : (serialized.charsBefore - serialized.charsAfter) / serialized.charsBefore;
}

function serializeOld(
	transcript: Transcript,
	calls: readonly ToolCandidate[],
	decisions: readonly Decision[],
	config: CompactionConfig,
	fitMode: SummaryFitMode = "normal",
): { text: string; charsBefore: number; charsAfter: number; messagesKept: number } {
	const actionByToolUseId = new Map<string, Decision["action"]>();
	const protectedCallByToolUseId = new Map<string, boolean>();
	for (const call of calls) {
		protectedCallByToolUseId.set(call.toolUseId, call.protectedCall);
	}
	for (const decision of decisions) {
		const call = calls.find((item) => item.id === decision.id);
		if (call) actionByToolUseId.set(call.toolUseId, decision.action);
	}
	const chunks: string[] = [];
	let charsBefore = 0;
	let charsAfter = 0;
	let messagesKept = 0;
	const resultMode = summaryResultMode(fitMode);
	for (let index = 0; index < transcript.oldCount; index += 1) {
		const message = transcript.messages[index];
		const parts: string[] = [];
		charsBefore += messageChars(message);
		if (message.thinking) {
			const text = abridgeSummaryText(message.thinking, fitMode, "thinking");
			parts.push(`[Assistant thinking]\n${text}`);
			charsAfter += text.length;
		}
		if (message.role === "assistant" && message.text) {
			const text = abridgeSummaryText(message.text, fitMode, "assistant");
			parts.push(`[Assistant]\n${text}`);
			charsAfter += text.length;
		}
		if (message.role === "user" && message.text) {
			const text = abridgeSummaryText(message.text, fitMode, "user");
			parts.push(`[User]\n${text}`);
			charsAfter += text.length;
		}
		for (const use of message.toolUses) {
			const action = actionByToolUseId.get(use.tool_use_id) ?? "keep";
			if (action === "drop_call") continue;
			const input = summaryInputText(
				safeJson(use.input),
				fitMode,
				protectedCallByToolUseId.get(use.tool_use_id) === true,
			);
			parts.push(`[Tool call ${use.tool}]\n${input}`);
			charsAfter += input.length;
		}
		for (const result of message.toolResults) {
			const action = actionByToolUseId.get(result.tool_use_id) ?? "keep";
			if (action === "drop_call") continue;
			const text = result.isError
				? result.text
				: resultMode === "minimal"
					? truncateResult(result.text, false, 0)
					: action === "drop_result"
						? truncateResult(result.text, false, config.truncateHeadChars)
						: resultMode === "head"
							? truncateResult(result.text, false, Math.min(config.truncateHeadChars, 300))
							: result.text;
			const label = result.isError || (action !== "drop_result" && resultMode === "normal") ? "verbatim" : "truncated";
			parts.push(`[Tool result ${result.toolName} — ${label}]\n${text}`);
			charsAfter += text.length;
		}
		if (parts.length > 0) {
			chunks.push(parts.join("\n\n"));
			messagesKept += 1;
		}
	}
	return { text: chunks.join("\n\n"), charsBefore, charsAfter, messagesKept };
}

function fitSerializedSummary(
	transcript: Transcript,
	calls: readonly ToolCandidate[],
	decisions: readonly Decision[],
	config: CompactionConfig,
	extraText: string,
): ReturnType<typeof serializeOld> & { mode: SummaryFitMode; summaryTokens: number } {
	let last: ReturnType<typeof serializeOld> | undefined;
	let lastTokens = Number.POSITIVE_INFINITY;
	let bestBudgetFit: (ReturnType<typeof serializeOld> & { mode: SummaryFitMode; summaryTokens: number }) | undefined;
	for (const mode of ["normal", "head", "minimal", "compact", "skeleton", "outline"] as const) {
		const serialized = serializeOld(transcript, calls, decisions, config, mode);
		last = serialized;
		const fullSummary = `${SUMMARY_HEADER}\n\n${serialized.text}${extraText}`;
		lastTokens = estimateTokens(fullSummary);
		if (lastTokens <= config.maxSummaryTokens) {
			const candidate = { ...serialized, mode, summaryTokens: lastTokens };
			bestBudgetFit = candidate;
			// Prefer the least destructive mode that meets the configured reduction target.
			// If no mode reaches the target, return the most compact mode that fits the budget.
			if (summaryReduction(serialized) >= config.minOldReduction) return candidate;
		}
	}
	return bestBudgetFit ?? { ...last!, mode: "outline", summaryTokens: lastTokens };
}

function fileDetails(fileOps: unknown): string {
	if (!fileOps || typeof fileOps !== "object") return "";
	const value = fileOps as { readFiles?: unknown; modifiedFiles?: unknown };
	const readFiles = Array.isArray(value.readFiles) ? value.readFiles.filter((item): item is string => typeof item === "string") : [];
	const modifiedFiles = Array.isArray(value.modifiedFiles) ? value.modifiedFiles.filter((item): item is string => typeof item === "string") : [];
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	return `\n\n## File operations\n\nRead files:\n${readFiles.map((item) => `- ${item}`).join("\n") || "- None"}\n\nModified files:\n${modifiedFiles.map((item) => `- ${item}`).join("\n") || "- None"}`;
}

function usage(input: number, output: number): CompactionUsage | undefined {
	if (input + output <= 0) return undefined;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

type SummaryBudget = {
	tokens: number;
	source: "configured" | "context_window" | "tokens_before" | "conservative_default";
};

function summaryBudget(contextWindow: number | undefined, tokensBefore?: number): SummaryBudget {
	const configured = Number(process.env.TYPESAFE_COMPACTION_MAX_SUMMARY_TOKENS);
	if (Number.isFinite(configured) && configured >= DEFAULT_SUMMARY_TOKENS) {
		return { tokens: configured, source: "configured" };
	}
	if (Number.isFinite(contextWindow) && (contextWindow ?? 0) > 0) {
		return { tokens: Math.max(DEFAULT_SUMMARY_TOKENS, Math.floor(contextWindow! * 0.4)), source: "context_window" };
	}
	if (Number.isFinite(tokensBefore) && (tokensBefore ?? 0) > 0) {
		return { tokens: Math.max(DEFAULT_SUMMARY_TOKENS, Math.floor(tokensBefore! * 0.4)), source: "tokens_before" };
	}
	return { tokens: 64_000, source: "conservative_default" };
}

export function defaultCompactionConfig(apiKey: string, contextWindow?: number, tokensBefore?: number): CompactionConfig {
	const budget = summaryBudget(contextWindow, tokensBefore);
	return {
		apiKey,
		model: typeSafeModel(),
		baseUrl: typeSafeBaseUrl(),
		keepThreshold: finiteEnv("TYPESAFE_COMPACTION_KEEP_THRESHOLD", 0.5, 0),
		maxStateTokens: finiteEnv("TYPESAFE_COMPACTION_MAX_STATE_TOKENS", DEFAULT_STATE_TOKENS),
		maxRequestTokens: finiteEnv("TYPESAFE_COMPACTION_MAX_REQUEST_TOKENS", DEFAULT_REQUEST_TOKENS),
		truncateHeadChars: finiteEnv("TYPESAFE_COMPACTION_TRUNCATE_HEAD_CHARS", DEFAULT_TRUNCATE_HEAD_CHARS, 0),
		minOldReduction: finiteEnv("TYPESAFE_COMPACTION_MIN_REDUCTION", DEFAULT_MIN_REDUCTION, 0),
		maxSummaryTokens: budget.tokens,
		summaryBudgetSource: budget.source,
		contextWindow,
		timeoutMs: finiteEnv("TYPESAFE_COMPACTION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
	};
}

export async function compactSession(params: {
	branchEntries: readonly SessionEntry[];
	firstKeptEntryId: string;
	tokensBefore: number;
	fileOps: unknown;
	signal: AbortSignal;
	config: CompactionConfig;
}): Promise<Success | Fallback> {
	const startedAt = Date.now();
	const contextEntries = compactedContextEntries(params.branchEntries);
	const transcript = convertBranch(contextEntries, params.firstKeptEntryId);
	if (!transcript) return { ok: false, fallback: "firstKeptEntryId not found on branch" };
	if (transcript.oldCount === 0) return { ok: false, fallback: "nothing to compact before kept window" };
	const calls = collectCalls(transcript);
	const candidates = calls.filter((call) => !call.pinned && !call.result?.isError);
	if (candidates.length === 0) return { ok: false, fallback: "no safe Jev candidates" };
	if (params.signal.aborted) return { ok: false, fallback: "compaction aborted" };

	let fit: StateFit;
	try {
		fit = fitState(transcript.messages, transcript.oldCount, params.config.maxStateTokens);
	} catch (error) {
		return { ok: false, fallback: error instanceof Error ? error.message : String(error) };
	}
	let requestBatches: ToolCandidate[][];
	try {
		requestBatches = batches(candidates, fit.tokens, params.config.maxRequestTokens);
	} catch (error) {
		return { ok: false, fallback: error instanceof Error ? error.message : String(error) };
	}

	let inputTokens = 0;
	let outputTokens = 0;
	const answers = new Map<string, Answer>();
	try {
		const results = await Promise.all(
			requestBatches.map((batch) => askBatch(batch, fit.text, params.config, params.signal)),
		);
		for (const result of results) {
			inputTokens += result.usage.input;
			outputTokens += result.usage.output;
			for (const [id, answer] of result.answers) answers.set(id, answer);
		}
	} catch (error) {
		return { ok: false, fallback: `Jev failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (params.signal.aborted) return { ok: false, fallback: "compaction aborted" };

	const decisions = calls.map((call) => decide(call, answers.get(call.id), params.config.keepThreshold));
	const fileDetailsText = fileDetails(params.fileOps);
	const serialized = fitSerializedSummary(transcript, calls, decisions, params.config, fileDetailsText);
	const fullSummary = `${SUMMARY_HEADER}\n\n${serialized.text}${fileDetailsText}`;
	const reduction = summaryReduction(serialized);
	const reductionWarning = reduction < params.config.minOldReduction
		? `压缩幅度 ${Math.round(reduction * 100)}% 低于阈值 ${Math.round(params.config.minOldReduction * 100)}%，已使用预算内 JEV 摘要`
		: undefined;
	if (serialized.summaryTokens > params.config.maxSummaryTokens) {
		return {
			ok: false,
			fallback:
				`summary exceeds ${params.config.maxSummaryTokens} tokens ` +
				`(estimated=${serialized.summaryTokens}, fit=${serialized.mode}, budget_source=${params.config.summaryBudgetSource})`,
		};
	}

	const candidatesForDetails = decisions.filter((decision) => decision.reason !== "pinned");
	const detail = {
		version: "typesafe-guard-jev-compaction-2",
		oldMessages: transcript.oldCount,
		keptMessages: transcript.messages.length - transcript.oldCount,
		oldCharsBefore: serialized.charsBefore,
		oldCharsAfter: serialized.charsAfter,
		oldReduction: reduction,
		stateTokens: fit.tokens,
		stateStage: fit.stage,
		requests: requestBatches.length,
		inputTokens,
		outputTokens,
		latencyMs: Date.now() - startedAt,
		contextWindow: params.config.contextWindow ?? null,
		summaryBudget: params.config.maxSummaryTokens,
		summaryBudgetSource: params.config.summaryBudgetSource,
		summaryTokens: serialized.summaryTokens,
		summaryFit: serialized.mode,
		reductionWarning: reductionWarning ?? null,
		decisions: candidatesForDetails.map((decision) => ({
			id: decision.id,
			tool: decision.tool,
			action: decision.action,
			reason: decision.reason,
			keepCall: Number(decision.keepCall.toFixed(3)),
			keepResult: Number(decision.keepResult.toFixed(3)),
		})),
	};
	const kept = decisions.filter((decision) => decision.action === "keep").length;
	const droppedResults = decisions.filter((decision) => decision.action === "drop_result").length;
	const droppedCalls = decisions.filter((decision) => decision.action === "drop_call").length;
	const report =
		`Jev 压缩完成：旧内容减少 ${Math.round(reduction * 100)}%，` +
		`工具调用保留 ${kept}/${decisions.length}，结果截断 ${droppedResults}，调用删除 ${droppedCalls}，` +
		`${requestBatches.length} 个请求，摘要拟合 ${serialized.mode}，${detail.latencyMs}ms` +
		`${reductionWarning ? `；${reductionWarning}` : ""}；未调用主模型摘要。`;
	return {
		ok: true,
		summary: fullSummary,
		firstKeptEntryId: params.firstKeptEntryId,
		tokensBefore: params.tokensBefore,
		usage: usage(inputTokens, outputTokens),
		details: { fastJev: detail },
		report,
	};
}
