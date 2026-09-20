import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { jevBudget, requestTypeSafe, typeSafeBaseUrl, typeSafeModel } from "../typesafe-core.mjs";

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
	previousSummary?: string;
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
	// 没有失败但也没有可做的事：整段历史都在保留窗口内，或用户主动取消。
	// 界面按说明展示，不报"回退"。
	notice?: "empty" | "cancelled";
};

type StateFit = {
	text: string;
	tokens: number;
	stage: string;
	// 状态里逐条渲染的调用；缺省表示状态覆盖了全部候选。
	callIds?: ReadonlySet<string>;
};

type ResultFitMode = "normal" | "head" | "minimal";
type SummaryFitMode = ResultFitMode | "compact" | "skeleton" | "outline" | "bounded";

type JevResponse = {
	model?: string;
	answers?: Record<string, { type?: string; noul?: number }>;
	usage?: { input_tokens?: number; output_tokens?: number };
};

const MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_SUMMARY_TOKENS = 16_000;
// 摘要预算按窗口份额算，再用绝对上限拦住大窗口（如 1M 窗口给出 40 万 Token 的常驻摘要）。
const DEFAULT_SUMMARY_SHARE = 0.4;
const DEFAULT_SUMMARY_CAP_TOKENS = 120_000;
// 受保护写操作在预算紧张的档位仍保留入参开头，供识别改了什么。
const PROTECTED_INPUT_HEAD_CHARS = 1_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_TRUNCATE_HEAD_CHARS = 300;
const DEFAULT_MIN_REDUCTION = 0.25;
const REQUEST_OVERHEAD_TOKENS = 64;
// 最后一级状态是有界的：旧窗口里逐条渲染的调用数封顶，超出的调用不进状态、不提问，
// 按保留处理（摘要侧仍按自己的预算裁剪），避免整个压缩退化成主模型摘要。
const MAX_STATE_OLD_CALLS = 200;
// 摘要最后一档只逐条展开最近这么多条旧消息，更早的只保留计数。
const MAX_SUMMARY_OLD_MESSAGES = 200;
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

function messageFromAgentMessage(raw: unknown): InternalMessage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	return messageFromEntry({ type: "message", message: raw } as unknown as SessionEntry);
}

type CompactionPreparationInput = {
	firstKeptEntryId: string;
	messagesToSummarize: readonly unknown[];
	turnPrefixMessages: readonly unknown[];
	previousSummary?: string;
	tokensBefore: number;
	fileOps: unknown;
};

function convertPreparation(
	branchEntries: readonly SessionEntry[],
	preparation: CompactionPreparationInput,
): Transcript | undefined {
	const keptIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	if (keptIndex < 0) return undefined;

	const oldMessages: InternalMessage[] = [];
	for (const raw of [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]) {
		const message = messageFromAgentMessage(raw);
		if (!message) continue;
		if (!message.text && !message.thinking && message.toolUses.length === 0 && message.toolResults.length === 0) continue;
		oldMessages.push(message);
	}

	const keptMessages: InternalMessage[] = [];
	for (let index = keptIndex; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (!entry || entry.type === "compaction") continue;
		const message = messageFromEntry(entry);
		if (!message) continue;
		if (!message.text && !message.thinking && message.toolUses.length === 0 && message.toolResults.length === 0) continue;
		keptMessages.push(message);
	}

	return {
		messages: [...oldMessages, ...keptMessages],
		oldCount: oldMessages.length,
		previousSummary: preparation.previousSummary,
	};
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

// Unrounded token weight. Token pieces never span whitespace, so the weight of a
// joined text equals the sum of its chunks and can be accumulated while building.
function tokenCount(text: string): number {
	let tokens = 0;
	for (const match of text.matchAll(TOKEN_PIECES)) {
		const piece = match[0];
		const first = piece.charCodeAt(0);
		if (first >= 48 && first <= 57) tokens += piece.length / 2;
		else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1 + Math.floor((piece.length - 1) / 6);
		else tokens += 0.9;
	}
	return tokens;
}

export function estimateTokens(text: string): number {
	return Math.ceil(tokenCount(text));
}

// 状态与问题都以 JSON 转义后的形态进入请求体：换行和引号会多占字符，转义符还会切断
// 字母片段。预算按请求体形态计量，否则拟合出的状态会比上限大出约四成。
const JSON_NEWLINE_TOKENS = tokenCount("\\n");

function bodyTokenCount(text: string): number {
	return tokenCount(JSON.stringify(text).slice(1, -1));
}

type FittedText = {
	text: string;
	tokens: number;
};

function abridge(text: string, head: number, tail: number): string {
	if (text.length <= head + tail + 40) return text;
	const suffix = tail > 0 ? `\n${text.slice(-tail)}` : "";
	return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]${suffix}`;
}

function resultText(result: ToolResult, mode: "full" | "head4000" | "head1000" | "meta"): string {
	if (mode === "full") return result.text;
	if (mode === "meta") return `[${result.text.length} chars${result.isError ? ", error" : ""}; result body omitted for Jev state]`;
	const limit = mode === "head4000" ? 4000 : 1000;
	if (result.text.length <= limit) return result.text;
	return `${result.text.slice(0, limit)}\n[${result.text.length - limit} chars omitted for Jev state]`;
}

function stateText(
	messages: readonly InternalMessage[],
	mode: "full" | "head4000" | "head1000" | "meta",
	tokenLimit: number,
): FittedText | undefined {
	const chunks: string[] = [];
	let tokens = 0;
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
		if (parts.length === 0) continue;
		const chunk = parts.join("\n\n");
		tokens += bodyTokenCount(chunk) + (chunks.length > 0 ? JSON_NEWLINE_TOKENS * 2 : 0);
		// This stage already exceeds the budget, so the rest of the oversized text is
		// neither built nor scanned.
		if (tokens > tokenLimit) return undefined;
		chunks.push(chunk);
	}
	return { text: chunks.join("\n\n"), tokens: Math.ceil(tokens) };
}

function compactStateText(
	messages: readonly InternalMessage[],
	oldCount: number,
	minimal: boolean,
	tokenLimit: number,
	bounded = false,
): (FittedText & { callIds?: ReadonlySet<string> }) | undefined {
	const chunks: string[] = [];
	let tokens = 0;
	const push = (chunk: string): boolean => {
		tokens += bodyTokenCount(chunk) + (chunks.length > 0 ? JSON_NEWLINE_TOKENS * 2 : 0);
		if (tokens > tokenLimit) return false;
		chunks.push(chunk);
		return true;
	};
	// 有界模式先锁定要逐条渲染的旧调用，超出的部分不进状态，由调用方按保留处理。
	let rendered: ReadonlySet<string> | undefined;
	let omitted = 0;
	if (bounded) {
		const ids: string[] = [];
		const limit = Math.min(oldCount, messages.length);
		for (let index = 0; index < limit; index += 1) {
			for (const use of messages[index].toolUses) ids.push(use.tool_use_id);
		}
		rendered = new Set(ids.slice(-MAX_STATE_OLD_CALLS));
		omitted = ids.length - rendered.size;
	}
	const goals = messages
		.filter((message) => message.role === "user" && message.toolResults.length === 0 && message.text.trim().length > 0)
		.slice(-3)
		.map((message) => abridge(message.text, 500, 120));
	if (goals.length > 0 && !push(`[Recent goals]\n${goals.join("\n---\n")}`)) return undefined;
	if (omitted > 0 && !push(`[${omitted} earlier tool calls not shown]`)) return undefined;
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
				if (rendered && old && !rendered.has(use.tool_use_id)) continue;
				const input = safeJson(use.input);
				parts.push(minimal
					? `[call ${use.tool}] ${abridge(input, 80, 0)}`
					: `[Tool call ${use.tool}]\n${abridge(input, 240, 0)}`);
			}
		}
		for (const result of message.toolResults) {
			if (rendered && old && !rendered.has(result.tool_use_id)) continue;
			const body = result.isError ? abridge(result.text, 300, 100) : `${result.text.length} chars omitted`;
			parts.push(minimal
				? `[result ${result.toolName}${result.isError ? ", error" : ""}] ${body}`
				: `[Tool result ${result.toolName}${result.isError ? ", error" : ""}]\n${body}`);
		}
		if (parts.length > 0 && !push(parts.join("\n\n"))) return undefined;
	}
	return { text: chunks.join("\n\n"), tokens: Math.ceil(tokens), callIds: rendered };
}

// The state is fitted once and shared by every request. A stage that already
// exceeds the budget stops early instead of materialising the whole oversized text.
function fitState(messages: readonly InternalMessage[], oldCount: number, maxTokens: number): StateFit {
	const stages: Array<[StateFit["stage"], Parameters<typeof stateText>[1]]> = [
		["full", "full"],
		["head4000", "head4000"],
		["head1000", "head1000"],
		["meta", "meta"],
	];
	for (const [stage, mode] of stages) {
		const fitted = stateText(messages, mode, maxTokens);
		if (fitted) return { ...fitted, stage };
	}
	for (const [stage, minimal] of [["compact", false], ["minimal", true]] as const) {
		const fitted = compactStateText(messages, oldCount, minimal, maxTokens);
		if (fitted) return { ...fitted, stage };
	}
	const bounded = compactStateText(messages, oldCount, true, maxTokens, true);
	if (bounded) return { ...bounded, stage: "minimal_bounded" };
	throw new Error(`Jev state exceeds ${maxTokens} tokens after staged reduction`);
}

// 问题正文、提问和预算估算共用同一个构造，避免估算与实际请求体漂移。
function callQuestions(tool: ToolCandidate): Array<[string, { type: "noul"; instructions: string }]> {
	return [
		[`call_${tool.id}`, {
			type: "noul",
			instructions: `Should the historical ${tool.tool} call remain in context, including its input? Keep it if the assistant may need to know that this action was attempted, especially for errors, constraints, or later decisions.`,
		}],
		[`result_${tool.id}`, {
			type: "noul",
			instructions: `Should the full output of historical ${tool.tool} call remain verbatim? Keep it if its exact contents may be needed; otherwise it may be shortened to a head and re-run note.`,
		}],
	];
}

function questionTokens(tool: ToolCandidate): number {
	// 问题在请求体里还要占用一个键值分隔符，一并计入，使估算不低于实际体积。
	return estimateTokens(`${JSON.stringify(Object.fromEntries(callQuestions(tool)))},`);
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
		for (const [key, question] of callQuestions(call)) questions[key] = question;
	}
	const payload = await requestTypeSafe({
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		model: config.model,
		state: { conversation: redact(state) },
		questions,
		signal,
		timeoutMs: config.timeoutMs,
	}) as JevResponse;
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
	if (mode === "bounded") return abridge(text, kind === "thinking" ? 40 : 80, 0);
	return text;
}

function summaryInputText(input: string, mode: SummaryFitMode, protectedCall: boolean): string {
	if (mode === "normal" || mode === "head" || mode === "minimal") return input;
	// 受保护写操作条目始终保留，只在紧凑档位把入参收到有界 head（预算里它占七成）。
	if (protectedCall) return abridge(input, PROTECTED_INPUT_HEAD_CHARS, 100);
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
	// 最后一档按价值丢弃：详细段之前的消息不逐条展开，但用户消息、失败结果和写操作目标
	// 属于不可恢复的内容，仍然保留，其余工具活动只留计数。
	const boundedCutoff = fitMode === "bounded" ? Math.max(0, transcript.oldCount - MAX_SUMMARY_OLD_MESSAGES) : 0;
	if (boundedCutoff > 0) {
		let calls = 0;
		let results = 0;
		const userHeads: string[] = [];
		const failures: string[] = [];
		const writes: string[] = [];
		for (let index = 0; index < boundedCutoff; index += 1) {
			const message = transcript.messages[index];
			calls += message.toolUses.length;
			results += message.toolResults.length;
			if (message.role === "user" && message.text.trim().length > 0) userHeads.push(abridge(message.text, 80, 0));
			for (const result of message.toolResults) {
				if (result.isError) failures.push(`[${result.toolName}] ${abridge(result.text, 150, 50)}`);
			}
			for (const use of message.toolUses) {
				if (!isWriteLikeTool(use.tool)) continue;
				writes.push(`${use.tool}: ${abridge(safeJson(use.input), 60, 0)}`);
			}
		}
		const block = [`[${boundedCutoff} earlier messages: ${calls} tool calls, ${results} results]`];
		if (userHeads.length > 0) block.push(`[Earlier user messages]\n${userHeads.join("\n")}`);
		if (failures.length > 0) block.push(`[Earlier tool failures]\n${failures.join("\n")}`);
		if (writes.length > 0) block.push(`[Earlier write-like calls]\n${writes.join("\n")}`);
		const joined = block.join("\n\n");
		chunks.push(joined);
		charsAfter += joined.length;
	}
	for (let index = 0; index < transcript.oldCount; index += 1) {
		const message = transcript.messages[index];
		const parts: string[] = [];
		charsBefore += messageChars(message);
		if (index < boundedCutoff) continue;
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
	for (const mode of ["normal", "head", "minimal", "compact", "skeleton", "outline", "bounded"] as const) {
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
	const share = (value: number, source: SummaryBudget["source"]): SummaryBudget => ({
		tokens: Math.max(DEFAULT_SUMMARY_TOKENS, Math.min(Math.floor(value * DEFAULT_SUMMARY_SHARE), DEFAULT_SUMMARY_CAP_TOKENS)),
		source,
	});
	if (Number.isFinite(contextWindow) && (contextWindow ?? 0) > 0) return share(contextWindow!, "context_window");
	if (Number.isFinite(tokensBefore) && (tokensBefore ?? 0) > 0) return share(tokensBefore!, "tokens_before");
	return { tokens: 64_000, source: "conservative_default" };
}

export function defaultCompactionConfig(apiKey: string, contextWindow?: number, tokensBefore?: number): CompactionConfig {
	const budget = summaryBudget(contextWindow, tokensBefore);
	// 单次请求取共享 Jev 预算的 75%，其余留给问题与响应；状态再取请求预算的 2/3。
	const requestTokens = finiteEnv("TYPESAFE_COMPACTION_MAX_REQUEST_TOKENS", Math.floor(jevBudget().requestTokens * 0.75));
	return {
		apiKey,
		model: typeSafeModel(),
		baseUrl: typeSafeBaseUrl(),
		keepThreshold: finiteEnv("TYPESAFE_COMPACTION_KEEP_THRESHOLD", 0.5, 0),
		maxStateTokens: finiteEnv("TYPESAFE_COMPACTION_MAX_STATE_TOKENS", Math.floor(requestTokens * 2 / 3)),
		maxRequestTokens: requestTokens,
		truncateHeadChars: finiteEnv("TYPESAFE_COMPACTION_TRUNCATE_HEAD_CHARS", DEFAULT_TRUNCATE_HEAD_CHARS, 0),
		minOldReduction: finiteEnv("TYPESAFE_COMPACTION_MIN_REDUCTION", DEFAULT_MIN_REDUCTION, 0),
		maxSummaryTokens: budget.tokens,
		summaryBudgetSource: budget.source,
		contextWindow,
		timeoutMs: finiteEnv("TYPESAFE_COMPACTION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
	};
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= items.length) return;
				results[index] = await run(items[index]!);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

export async function compactSession(params: {
	branchEntries: readonly SessionEntry[];
	preparation: CompactionPreparationInput;
	signal: AbortSignal;
	config: CompactionConfig;
}): Promise<Success | Fallback> {
	const startedAt = Date.now();
	const transcript = convertPreparation(params.branchEntries, params.preparation);
	if (!transcript) return { ok: false, fallback: "会话分支状态异常：找不到保留点" };
	if (transcript.oldCount === 0) {
		return { ok: false, notice: "empty", fallback: "整段历史都在保留窗口内，没有可压缩的内容" };
	}
	const calls = collectCalls(transcript);
	const candidates = calls.filter((call) => !call.pinned && !call.result?.isError);
	if (candidates.length === 0) return { ok: false, fallback: "没有需要判断的工具调用，交回主模型压缩" };
	if (params.signal.aborted) return { ok: false, notice: "cancelled", fallback: "压缩已取消" };

	let fit: StateFit;
	try {
		fit = fitState(transcript.messages, transcript.oldCount, params.config.maxStateTokens);
	} catch (error) {
		return { ok: false, fallback: error instanceof Error ? error.message : String(error) };
	}
	// 只对状态里真正渲染出来的调用提问；被状态裁掉的调用没有依据，按保留处理。
	const askable = fit.callIds ? candidates.filter((call) => fit.callIds?.has(call.toolUseId)) : candidates;
	let requestBatches: ToolCandidate[][];
	try {
		requestBatches = batches(askable, fit.tokens, params.config.maxRequestTokens);
	} catch (error) {
		return { ok: false, fallback: error instanceof Error ? error.message : String(error) };
	}

	let inputTokens = 0;
	let outputTokens = 0;
	const answers = new Map<string, Answer>();
	try {
		const results = await mapWithConcurrency(
			requestBatches,
			MAX_CONCURRENT_REQUESTS,
			(batch) => askBatch(batch, fit.text, params.config, params.signal),
		);
		for (const result of results) {
			inputTokens += result.usage.input;
			outputTokens += result.usage.output;
			for (const [id, answer] of result.answers) answers.set(id, answer);
		}
	} catch (error) {
		return { ok: false, fallback: `Jev 请求失败：${error instanceof Error ? error.message : String(error)}` };
	}
	if (params.signal.aborted) return { ok: false, notice: "cancelled", fallback: "压缩已取消" };

	const decisions = calls.map((call) => decide(call, answers.get(call.id), params.config.keepThreshold));
	const fileDetailsText = fileDetails(params.preparation.fileOps);
	const previousSummaryText = transcript.previousSummary
		? `\n\n## Existing compaction summary\n${abridge(transcript.previousSummary, 5000, 800)}`
		: "";
	const summaryContext = `${previousSummaryText}${fileDetailsText}`;
	const serialized = fitSerializedSummary(transcript, calls, decisions, params.config, summaryContext);
	const fullSummary = `${SUMMARY_HEADER}\n\n${serialized.text}${summaryContext}`;
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
		version: "lystar-jev-compaction-5",
		stateTokensTotal: fit.tokens * requestBatches.length,
		previousSummaryMerged: Boolean(transcript.previousSummary),
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
		`${requestBatches.length} 个请求，状态拟合 ${fit.stage} ${fit.tokens} Token，摘要拟合 ${serialized.mode}，${detail.latencyMs}ms` +
		`${reductionWarning ? `；${reductionWarning}` : ""}；未调用主模型摘要。`;
	return {
		ok: true,
		summary: fullSummary,
		firstKeptEntryId: params.preparation.firstKeptEntryId,
		tokensBefore: params.preparation.tokensBefore,
		usage: usage(inputTokens, outputTokens),
		details: { fastJev: detail },
		report,
	};
}
