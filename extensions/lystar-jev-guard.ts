import { isAbsolute, relative, resolve } from "node:path";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { envNumber, requestTypeSafe, resolveApiKey, typeSafeModel } from "./typesafe-core.mjs";

type NoulAnswer = {
	type: "noul";
	noul: number;
};

type TypeSafeResponse = {
	model?: string;
	answers?: Record<string, NoulAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
};

type PreflightStatus = "allowed" | "advisory" | "needs_confirmation";

type PreflightDecision = {
	status: PreflightStatus;
	needsConfirmation: boolean;
	taskRelated: number;
	scopeViolation: number;
	confirmation: number;
	highImpact: boolean;
	model?: string;
	usage?: TypeSafeResponse["usage"];
	latencyMs: number;
};

const CACHE_LIMIT = 64;
const TASK_RELATED_ADVISORY_THRESHOLD = 0.08;
const SCOPE_VIOLATION_ADVISORY_THRESHOLD = 0.92;
const CONFIRM_THRESHOLD = 0.88;

const PREFLIGHT_TOOLS = new Set(["bash", "powershell", "write", "edit"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_ONLY_SHELL = /^(?:pwd|cd|ls|tree|whoami|hostname|uname|date|find|rg|grep|ag|cat|bat|head|tail|less|wc|file|stat|realpath|readlink|basename|dirname|du|df|jq|diff|cmp|sort|uniq|cut|column|nl|xxd)\b/i;
const READ_ONLY_GIT = /^git\s+(?:status|diff|log|show|branch)(?:\s|$)/i;
const SAFE_STDERR_REDIRECT = /\s+2\s*>\s*\/dev\/null\s*$/i;

let currentPrompt = "";
let warnedMissingKey = false;
let debugEnabled = false;
type CachedDecision = Promise<PreflightDecision> | PreflightDecision;
let cache = new Map<string, CachedDecision>();

function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function redact(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, "$1[REDACTED]")
		.replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
		.replace(/apikey_[A-Za-z0-9_]+/g, "[REDACTED]");
}

function safeJson(value: unknown, max: number): string {
	try {
		return clip(redact(JSON.stringify(value)), max);
	} catch {
		return "[unserializable tool input]";
	}
}

type SessionContext = {
	sessionManager?: {
		getBranch?: () => readonly unknown[];
		getLeafId?: () => string | null | undefined;
	};
};

type ExecutionContext = {
	recentAssistantPlan: string;
	recentActivity: string[];
	branchLeafId: string;
};

type ShellSplitResult = {
	segments: string[];
	unsafe: boolean;
};

/** 按 Shell 语法拆分链式命令，忽略引号中的管道和分号。 */
function splitShellChain(command: string): ShellSplitResult {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let unsafe = false;

	const flush = () => {
		const segment = current.trim();
		if (segment) segments.push(segment);
		current = "";
	};

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			current += character;
			escaped = true;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			current += character;
			continue;
		}
		if (character === "\n" || character === ";") {
			flush();
			continue;
		}
		if (character === "|") {
			flush();
			if (command[index + 1] === "|") index += 1;
			continue;
		}
		if (character === "&") {
			if (command[index + 1] === "&") {
				flush();
				index += 1;
				continue;
			}
			unsafe = true;
		}
		if (character === "(" || character === ")" || character === "`") unsafe = true;
		current += character;
	}

	if (escaped || quote) unsafe = true;
	flush();
	return { segments, unsafe };
}

function hasUnquotedShellCharacter(value: string, characters: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of value) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (characters.includes(character)) return true;
	}
	return false;
}

function hasCommandSubstitution(value: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			if (character === "$" && value[index + 1] === "(" && quote !== "'") return true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "`" || (character === "$" && value[index + 1] === "(")) return true;
	}
	return false;
}

function isReadOnlyShellSegment(rawSegment: string): boolean {
	const segment = rawSegment.replace(SAFE_STDERR_REDIRECT, "").trim();
	if (!segment || hasUnquotedShellCharacter(segment, "<>") || hasCommandSubstitution(segment)) return false;
	if (/^printf(?:\s|$)/i.test(segment) || /^printenv(?:\s|$)/i.test(segment)) return true;
	if (/^find(?:\s|$)/i.test(segment)) {
		return !/\s-(?:delete|exec|execdir|ok|okdir)\b/i.test(segment);
	}
	if (/^git(?:\s|$)/i.test(segment)) {
		if (!READ_ONLY_GIT.test(segment)) return false;
		if (/^git\s+branch\b.*(?:\s-D\b|\s--delete\b)/i.test(segment)) return false;
		if (/^git\s+diff\b.*(?:\s-o(?:\s|=)|\s--output(?:\s|=))/i.test(segment)) return false;
		return true;
	}
	return READ_ONLY_SHELL.test(segment);
}

export function isReadOnlyShell(input: Record<string, unknown>): boolean {
	const command = typeof input.command === "string" ? input.command.trim() : "";
	if (!command) return false;
	const { segments, unsafe } = splitShellChain(command);
	return !unsafe && segments.length > 0 && segments.every(isReadOnlyShellSegment);
}

export function shouldPreflight(toolName: string, input: Record<string, unknown>): boolean {
	if (READ_ONLY_TOOLS.has(toolName) || !PREFLIGHT_TOOLS.has(toolName)) return false;
	// 当前没有 PowerShell 解析器，不能用 Unix 命令白名单误放行 PowerShell。
	if (toolName === "bash" && isReadOnlyShell(input)) return false;
	return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			return record?.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function pathSummary(inputPath: string, cwd: string): Record<string, unknown> {
	const absolutePath = resolve(cwd, inputPath);
	const relativePath = relative(cwd, absolutePath);
	const insideWorkingDirectory =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith("../") && !relativePath.startsWith("..\\") && !isAbsolute(relativePath));
	return {
		path: redact(absolutePath),
		relative_path: insideWorkingDirectory ? relativePath || "." : null,
		inside_working_directory: insideWorkingDirectory,
	};
}

function proposedAction(toolName: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
	const action: Record<string, unknown> = { tool: toolName };
	if (typeof input.path === "string") Object.assign(action, pathSummary(input.path, cwd));
	if (toolName === "edit") {
		const edits = Array.isArray(input.edits) ? input.edits : [];
		action.edit_count = edits.length;
		action.change_preview = edits.slice(0, 3).map((item) => {
			const edit = asRecord(item);
			return {
				old: typeof edit?.oldText === "string" ? clip(redact(edit.oldText), 240) : "",
				new: typeof edit?.newText === "string" ? clip(redact(edit.newText), 240) : "",
			};
		});
	}
	if (toolName === "write" && typeof input.content === "string") {
		action.content_length = input.content.length;
		action.content_preview = clip(redact(input.content), 500);
	}
	if ((toolName === "bash" || toolName === "powershell") && typeof input.command === "string") {
		action.command = clip(redact(input.command), 4000);
	}
	return action;
}

function activitySummary(toolName: string, input: Record<string, unknown>, cwd: string): string {
	const action = proposedAction(toolName, input, cwd);
	const target = typeof action.relative_path === "string"
		? action.relative_path
		: typeof action.path === "string"
			? action.path
			: typeof action.command === "string"
				? String(action.command).split("\n", 1)[0]
				: "";
	return clip(`${toolName}${target ? `: ${target}` : ""}`, 300);
}

function recentExecutionContext(ctx: SessionContext, cwd: string): ExecutionContext {
	let branch: readonly unknown[] = [];
	try {
		branch = ctx.sessionManager?.getBranch?.() ?? [];
	} catch {
		branch = [];
	}
	const assistantPlans: string[] = [];
	const activity: string[] = [];
	for (const entryValue of branch.slice(-24)) {
		const entry = asRecord(entryValue);
		if (entry?.type !== "message") continue;
		const message = asRecord(entry.message);
		if (!message) continue;
		if (message.role === "assistant") {
			const text = clip(redact(textContent(message.content)), 1400).trim();
			if (text) {
				assistantPlans.push(text);
				while (assistantPlans.length > 2) assistantPlans.shift();
			}
			if (Array.isArray(message.content)) {
				for (const partValue of message.content) {
					const part = asRecord(partValue);
					if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
					activity.push(activitySummary(part.name, asRecord(part.arguments) ?? {}, cwd));
					while (activity.length > 6) activity.shift();
				}
			}
		}
		if (message.role === "toolResult" && typeof message.toolName === "string") {
			const resultText = clip(redact(textContent(message.content).replace(/\s+/g, " ")), 180);
			activity.push(`${message.toolName} ${message.isError === true ? "failed" : "succeeded"}${resultText ? `: ${resultText}` : ""}`);
			while (activity.length > 6) activity.shift();
		}
	}
	let branchLeafId = "";
	try {
		branchLeafId = ctx.sessionManager?.getLeafId?.() ?? "";
	} catch {
		branchLeafId = "";
	}
	return {
		recentAssistantPlan: assistantPlans.join("\n---\n"),
		recentActivity: activity,
		branchLeafId,
	};
}

function isHighImpactAction(toolName: string, action: Record<string, unknown>): boolean {
	if ((toolName === "write" || toolName === "edit") && action.inside_working_directory === false) return true;
	if (toolName !== "bash" && toolName !== "powershell") return false;
	const command = typeof action.command === "string" ? action.command : "";
	return /(?:^|[\s;&|])(?:sudo|su|ssh|scp)\b|\brm\s+(?:-[A-Za-z]*[rf][A-Za-z]*\s+|--recursive\b|--force\b)|\bgit\s+(?:push|reset\s+--hard|clean\s+-[A-Za-z]*f)|\bsystemctl\s+(?:restart|stop|disable|enable)\b|\bnpm\s+publish\b/i.test(command);
}

function cacheKey(toolName: string, action: Record<string, unknown>, execution: ExecutionContext): string {
	return JSON.stringify({
		prompt: redact(clip(currentPrompt, 6000)),
		toolName,
		action,
		branchLeafId: execution.branchLeafId,
	});
}

function cacheSet(key: string, value: CachedDecision): void {
	cache.set(key, value);
	while (cache.size > CACHE_LIMIT) {
		const first = cache.keys().next().value;
		if (first === undefined) break;
		cache.delete(first);
	}
}

function answerValue(response: TypeSafeResponse, name: string): number {
	const value = response.answers?.[name]?.noul;
	return typeof value === "number" && Number.isFinite(value) ? value : 0.5;
}

export async function requestSystemOne(
	state: unknown,
	questions: Record<string, unknown>,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TypeSafeResponse> {
	return requestTypeSafe({
		state,
		questions,
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? envNumber("TYPESAFE_GUARD_TIMEOUT_MS", 1800),
	}) as Promise<TypeSafeResponse>;
}

async function evaluate(
	toolName: string,
	action: Record<string, unknown>,
	execution: ExecutionContext,
	cwd: string,
): Promise<PreflightDecision> {
	const startedAt = Date.now();
	const model = typeSafeModel();

	const state = {
		user_request: redact(clip(currentPrompt, 6000)),
		working_directory: cwd,
		execution_context: {
			recent_assistant_plan: execution.recentAssistantPlan || "(no recent assistant plan)",
			recent_tool_activity: execution.recentActivity,
		},
		proposed_action: action,
	};

		const payload = await requestSystemOne(state, {
					task_related: {
						type: "noul",
						instructions: "Considering `user_request`, `execution_context`, and `proposed_action`, is the proposed action a plausible direct implementation, diagnosis, recovery, or verification step for the current task? It does not need to be the only possible or strictly necessary step.",
						criteria: {
							true: "The action reasonably advances the stated task or the assistant's bounded implementation plan. Creating a helper, API, test, or configuration file can be related when the recent plan explains that role.",
							false: "The action has no credible connection to the request or recent implementation context.",
						},
					},
					scope_violation: {
						type: "noul",
						instructions: "Does `proposed_action` clearly exceed or contradict the scope established by `user_request` and `execution_context`?",
						criteria: {
							true: "The action targets clearly unrelated work, contradicts an explicit restriction, or materially expands the task.",
							false: "The action is related supporting work, a reversible local implementation step, or the available evidence is insufficient to call it a clear violation.",
						},
					},
					needs_confirmation: {
						type: "noul",
						instructions: "Should a human confirm `proposed_action` before it executes?",
						criteria: {
							true: "The action is destructive, irreversible, external, affects resources outside the working directory, or materially changes the requested scope.",
							false: "The action is a normal, reversible implementation or verification step within the task.",
						},
					},
		});
		const taskRelated = answerValue(payload, "task_related");
		const scopeViolation = answerValue(payload, "scope_violation");
		const confirmation = answerValue(payload, "needs_confirmation");
		const highImpact = isHighImpactAction(toolName, action);
		const semanticConcern =
			taskRelated <= TASK_RELATED_ADVISORY_THRESHOLD &&
			scopeViolation >= SCOPE_VIOLATION_ADVISORY_THRESHOLD;
		const needsConfirmation = highImpact && (confirmation >= CONFIRM_THRESHOLD || semanticConcern);

		return {
			status: needsConfirmation ? "needs_confirmation" : semanticConcern ? "advisory" : "allowed",
			needsConfirmation,
			taskRelated,
			scopeViolation,
			confirmation,
			highImpact,
			model: payload.model || model,
			usage: payload.usage,
			latencyMs: Date.now() - startedAt,
		};
}

function statusText(decision: PreflightDecision): string {
	const action = decision.status === "needs_confirmation"
		? "需确认"
		: decision.status === "advisory"
			? "范围提示（已放行）"
			: "放行";
	return `Jev ${action} · 任务关联 ${decision.taskRelated.toFixed(2)} · 越界概率 ${decision.scopeViolation.toFixed(2)}`;
}

function debugLog(message: string): void {
	if (debugEnabled) console.error(`[lystar-jev-guard] ${message}`);
}

function notify(ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else debugLog(message);
}

export default function lystarJevGuard(pi: ExtensionAPI): void {
	debugEnabled = process.env.TYPESAFE_GUARD_DEBUG === "1";

	pi.on("before_agent_start", (event) => {
		currentPrompt = event.prompt;
		cache = new Map();
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (process.env.TYPESAFE_GUARD_DISABLE === "1") return;
		if (!shouldPreflight(event.toolName, event.input)) return;

		if (!resolveApiKey()) {
			if (!warnedMissingKey) {
				warnedMissingKey = true;
				notify(ctx, "JEV Key 未设置，Jev 工具预检已放行", "warning");
			}
			return;
		}

		const execution = recentExecutionContext(ctx, ctx.cwd);
		const action = proposedAction(event.toolName, event.input, ctx.cwd);
		const key = cacheKey(event.toolName, action, execution);
		let pending = cache.get(key);
		if (!pending) {
			pending = evaluate(event.toolName, action, execution, ctx.cwd).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				debugLog(`preflight failed: ${message}`);
				throw error;
			});
			cacheSet(key, pending);
		}

		let decision: PreflightDecision;
		try {
			decision = await pending;
			cacheSet(key, decision);
		} catch {
			cache.delete(key);
			// JEV is a workflow signal, not the permission boundary. API failure never
			// blocks the user's normal coding path.
			if (ctx.hasUI) ctx.ui.setStatus("lystar-jev-guard", "Jev 不可用 · 已按回退策略放行");
			notify(ctx, "Jev 不可用，已按回退策略放行当前工具调用", "warning");
			return;
		}

		debugLog(
			`tool=${event.toolName} status=${decision.status} ` +
			`task_related=${decision.taskRelated.toFixed(3)} scope_violation=${decision.scopeViolation.toFixed(3)} ` +
			`confirm=${decision.confirmation.toFixed(3)} high_impact=${decision.highImpact} ` +
			`model=${decision.model || "unknown"} latency_ms=${decision.latencyMs}`,
		);

		if (ctx.hasUI) ctx.ui.setStatus("lystar-jev-guard", statusText(decision));
		if (decision.status === "advisory") {
			notify(
				ctx,
				`Jev 范围提示：任务关联 ${decision.taskRelated.toFixed(2)}，越界概率 ${decision.scopeViolation.toFixed(2)}；当前操作可逆且影响有限，已放行`,
				"warning",
			);
		}

		if (decision.needsConfirmation) {
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: "Jev 需要人工确认（工具未执行）：当前运行模式不支持确认对话",
				};
			}

			const preview = clip(redact(safeJson(event.input, 500)), 500);
			const confirmed = await ctx.ui.confirm(
				"Jev 工具预检",
				`工具：${event.toolName}\n输入：${preview}\n\nJev 判断该调用可能产生外部或不可逆影响，是否继续？`,
			);
			if (!confirmed) {
				return { block: true, reason: "用户取消 Jev 确认（工具未执行）" };
			}
		}
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx) => {
		if (!event.isError) return;
		cache = new Map();
		debugLog(`execution_failed tool=${event.toolName}`);
		if (ctx.hasUI) ctx.ui.setStatus("lystar-jev-guard", `工具执行失败（真实返回）· ${event.toolName}`);
	});

}
