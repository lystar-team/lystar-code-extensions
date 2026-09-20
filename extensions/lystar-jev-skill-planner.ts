import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	Skill,
} from "@earendil-works/pi-coding-agent";
import { envNumber, requestTypeSafe, resolveApiKey } from "./typesafe-core.mjs";

type NoulAnswer = {
	type?: "noul";
	noul?: number;
};

type ChoiceAnswer = {
	type?: "choice";
	choice?: string;
	confidence?: number;
	probabilities?: Record<string, number>;
};

type TypeSafeAnswer = NoulAnswer | ChoiceAnswer;

type TypeSafeResponse = {
	model?: string;
	answers?: Record<string, TypeSafeAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
};

type SkillCandidate = {
	name: string;
	description: string;
	explicit: boolean;
};

type SkillScore = SkillCandidate & {
	relevance: number;
};

type SkillPlan = {
	selected: SkillScore[];
	needSkill: number;
	responseMode: ResponseMode;
	concise: number;
	carryPrevious: number;
	model?: string;
	latencyMs: number;
};

type ResponseMode = "direct" | "plan" | "implementation_report" | "document";

type PlannerState = {
	request: string;
	explicitSkills: string[];
	availableSkills: Array<{ name: string; description: string }>;
	previousSkills: string[];
};

const DEFAULT_TIMEOUT_MS = 1800;
const DEFAULT_NEED_THRESHOLD = 0.5;
const DEFAULT_RELEVANCE_THRESHOLD = 0.5;
const DEFAULT_CARRY_THRESHOLD = 0.5;

let previousPlan: SkillPlan | undefined;
let planCache = new Map<string, SkillPlan>();
let debugEnabled = false;

function envProbability(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function debugLog(message: string): void {
	if (debugEnabled) console.error(`[lystar-jev-skill-planner] ${message}`);
}

function extractExplicitSkillNames(prompt: string): string[] {
	const names = new Set<string>();
	const patterns = [
		/<skill\b[^>]*\bname="([a-z0-9][a-z0-9-]*)"/giu,
		/<skill_reference\b[^>]*\bname="([a-z0-9][a-z0-9-]*)"/giu,
	];
	for (const pattern of patterns) {
		for (const match of prompt.matchAll(pattern)) {
			const name = match[1]?.toLowerCase();
			if (name) names.add(name);
		}
	}
	return [...names];
}

function stripSkillMarkup(prompt: string): string {
	return prompt
		.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/giu, "[explicit Skill content]")
		.replace(/<skill_references\b>[\s\S]*?<\/skill_references>/giu, "[Skill references]")
		.trim();
}

function buildState(
	event: BeforeAgentStartEvent,
	skills: Skill[],
): { state: PlannerState; candidates: SkillCandidate[] } {
	const explicitSkills = extractExplicitSkillNames(event.prompt);
	const explicitSet = new Set(explicitSkills);
	const candidates = skills
		.filter((skill) => !skill.disableModelInvocation || explicitSet.has(skill.name))
		.map((skill) => ({
			name: skill.name,
			description: clip(skill.description, 320),
			explicit: explicitSet.has(skill.name),
		}));

	return {
		state: {
			request: clip(stripSkillMarkup(event.prompt), 8000),
			explicitSkills,
			availableSkills: candidates.map(({ name, description }) => ({ name, description })),
			previousSkills: previousPlan?.selected.map((skill) => skill.name) ?? [],
		},
		candidates,
	};
}

function buildQuestions(candidates: SkillCandidate[], hasPreviousPlan: boolean): Record<string, unknown> {
	const questions: Record<string, unknown> = {
		need_skill: {
			type: "noul",
			instructions: "Does this request need one or more specialized Skills before the main model answers or acts?",
			criteria: {
				true: "A listed Skill contains task-specific rules, workflow, tools, terminology, or output constraints that help this request.",
				false: "The request is ordinary conversation or can be handled without a listed Skill.",
			},
		},
		response_mode: {
			type: "choice",
			instructions: "Which response shape best fits the user's current request?",
			criteria: {
				direct: "Answer the question or result directly in short, simple language.",
				plan: "Give a clear plan or decision structure before implementation.",
				implementation_report: "Report completed changes, verification, and remaining uncertainty.",
				document: "Produce a complete document or polished text that follows the requested format.",
			},
		},
		concise: {
			type: "noul",
			instructions: "Should the response stay short and use simple, direct language?",
			criteria: {
				true: "The user wants a direct answer, short report, simple wording, or focused result.",
				false: "The task needs a longer document or detailed explanation to be complete.",
			},
		},
	};

	if (hasPreviousPlan) {
		questions.carry_previous = {
			type: "noul",
			instructions: "Should the previous turn's selected Skills remain relevant for this request?",
			criteria: {
				true: "The request continues the same work or depends on the previous Skill context.",
				false: "The request starts a different task or the previous Skills are no longer useful.",
			},
		};
	}

	for (const [index, candidate] of candidates.entries()) {
		questions[`skill_${index}`] = {
			type: "noul",
			instructions: `Is the Skill named ${candidate.name} relevant to this request? Judge the Skill description against the request.`,
			criteria: {
				true: "The Skill's stated capability directly helps complete this request.",
				false: "The Skill is unrelated, redundant, or only vaguely connected to this request.",
			},
		};
	}

	return questions;
}

function answerNoul(response: TypeSafeResponse, key: string, fallback = 0.5): number {
	const value = response.answers?.[key];
	const noul = value && "noul" in value ? value.noul : undefined;
	return typeof noul === "number" && Number.isFinite(noul) ? Math.max(0, Math.min(1, noul)) : fallback;
}

function answerChoice(response: TypeSafeResponse, key: string): ResponseMode {
	const value = response.answers?.[key];
	const choice = value && "choice" in value ? value.choice : undefined;
	if (choice === "plan" || choice === "implementation_report" || choice === "document") return choice;
	return "direct";
}

async function askJev(state: PlannerState, questions: Record<string, unknown>): Promise<{ response: TypeSafeResponse; latencyMs: number }> {
	const timeoutMs = envNumber("TYPESAFE_SKILL_PLANNER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
	const startedAt = Date.now();
	const response = await requestTypeSafe({ state, questions, timeoutMs });
	return {
		response: response as TypeSafeResponse,
		latencyMs: Date.now() - startedAt,
	};
}

function createPlan(
	state: PlannerState,
	candidates: SkillCandidate[],
	response: TypeSafeResponse,
	latencyMs: number,
): SkillPlan {
	const needSkill = answerNoul(response, "need_skill");
	const carryPrevious = state.previousSkills.length > 0 ? answerNoul(response, "carry_previous") : 0;
	const needThreshold = envProbability("TYPESAFE_SKILL_NEED_THRESHOLD", DEFAULT_NEED_THRESHOLD);
	const relevanceThreshold = envProbability("TYPESAFE_SKILL_RELEVANCE_THRESHOLD", DEFAULT_RELEVANCE_THRESHOLD);
	const carryThreshold = envProbability("TYPESAFE_SKILL_CARRY_THRESHOLD", DEFAULT_CARRY_THRESHOLD);
	const explicitSet = new Set(state.explicitSkills);
	const shouldSelectAutomatically = needSkill >= needThreshold;
	const selected = new Map<string, SkillScore>();

	for (const [index, candidate] of candidates.entries()) {
		const relevance = answerNoul(response, `skill_${index}`, candidate.explicit ? 1 : 0);
		const carried = carryPrevious >= carryThreshold && state.previousSkills.includes(candidate.name);
		if (candidate.explicit || (shouldSelectAutomatically && relevance >= relevanceThreshold) || (carried && relevance >= relevanceThreshold * 0.7)) {
			selected.set(candidate.name, { ...candidate, relevance });
		}
	}

	for (const name of explicitSet) {
		if (!selected.has(name)) {
			selected.set(name, { name, description: "用户显式指定的 Skill", explicit: true, relevance: 1 });
		}
	}

	return {
		selected: [...selected.values()].sort((left, right) => {
			if (left.explicit !== right.explicit) return left.explicit ? -1 : 1;
			return right.relevance - left.relevance;
		}),
		needSkill,
		responseMode: answerChoice(response, "response_mode"),
		concise: answerNoul(response, "concise", 1),
		carryPrevious,
		model: response.model,
		latencyMs,
	};
}

function responseGuidance(plan: SkillPlan): string {
	if (plan.responseMode === "plan") return "先给结论，再列必要步骤。";
	if (plan.responseMode === "implementation_report") return "先汇报结果，再列改动和已验证内容；未验证内容直说。";
	if (plan.responseMode === "document") return "按用户要求组织完整内容，保留事实和责任主体。";
	return "直接回答当前问题，使用简单、直白的中文。";
}

export function buildGuidanceBlock(plan: SkillPlan): string {
	const skills = plan.selected.map((skill) => escapeXml(skill.name)).join(",") || "none";
	const guidance = responseGuidance(plan);
	const language = plan.selected.some((skill) => skill.name === "shuorenhua")
		? "；删掉套话、拔高和无关解释"
		: "";
	const instruction = language ? `${guidance.replace(/。$/, "")}${language}` : guidance;
	return `\n<jev_skill_plan skills="${skills}" mode="${plan.responseMode}" concise="${plan.concise >= 0.5 ? "true" : "false"}">${escapeXml(instruction)}</jev_skill_plan>`;
}

function planKey(state: PlannerState, candidates: SkillCandidate[]): string {
	return JSON.stringify({
		request: state.request,
		candidates: candidates.map((candidate) => [candidate.name, candidate.description]),
		previousSkills: state.previousSkills,
	});
}

function explicitPlan(state: PlannerState, candidates: SkillCandidate[]): SkillPlan | undefined {
	if (state.explicitSkills.length === 0) return undefined;
	const selected = new Map<string, SkillScore>();
	for (const candidate of candidates.filter((item) => item.explicit)) {
		selected.set(candidate.name, { ...candidate, relevance: 1 });
	}
	for (const name of state.explicitSkills) {
		if (!selected.has(name)) {
			selected.set(name, { name, description: "用户显式指定的 Skill", explicit: true, relevance: 1 });
		}
	}
	return {
		selected: [...selected.values()],
		needSkill: 1,
		responseMode: "direct",
		concise: 1,
		carryPrevious: 0,
		latencyMs: 0,
	};
}

async function planTurn(event: BeforeAgentStartEvent): Promise<SkillPlan> {
	const skills = event.systemPromptOptions.skills ?? [];
	const { state, candidates } = buildState(event, skills);
	const key = planKey(state, candidates);
	const cached = planCache.get(key);
	if (cached) return cached;
	const remember = (plan: SkillPlan): SkillPlan => {
		planCache.set(key, plan);
		while (planCache.size > 16) planCache.delete(planCache.keys().next().value!);
		return plan;
	};
	const direct = explicitPlan(state, candidates);
	if (direct) {
		const fullQuestions = buildQuestions([], false);
		const questions = {
			response_mode: fullQuestions.response_mode,
			concise: fullQuestions.concise,
		};
		const result = await askJev({ ...state, availableSkills: [] }, questions);
		return remember({
			...direct,
			responseMode: answerChoice(result.response, "response_mode"),
			concise: answerNoul(result.response, "concise", 1),
			model: result.response.model,
			latencyMs: result.latencyMs,
		});
	}
	if (candidates.length === 0) {
		return { selected: [], needSkill: 0, responseMode: "direct", concise: 1, carryPrevious: 0, latencyMs: 0 };
	}
	const questions = buildQuestions(candidates, state.previousSkills.length > 0);
	const result = await askJev(state, questions);
	return remember(createPlan(state, candidates, result.response, result.latencyMs));
}

export default function lystarJevSkillPlanner(pi: ExtensionAPI): void {
	debugEnabled = process.env.TYPESAFE_SKILL_PLANNER_DEBUG === "1";

	pi.on("session_start", () => {
		previousPlan = undefined;
		planCache = new Map();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (process.env.TYPESAFE_SKILL_PLANNER_DISABLE === "1") return;
		if (!resolveApiKey()) {
			debugLog("planner skipped: no TypeSafe API key");
			return;
		}

		try {
			const plan = await planTurn(event);
			previousPlan = plan;

			const guidance = buildGuidanceBlock(plan);
			debugLog(
				`selected=${plan.selected.map((skill) => skill.name).join(",") || "none"} ` +
				`need=${plan.needSkill.toFixed(3)} mode=${plan.responseMode} ` +
				`concise=${plan.concise.toFixed(3)} carry=${plan.carryPrevious.toFixed(3)} ` +
				`model=${plan.model || "unknown"} latency_ms=${plan.latencyMs}`,
			);
			if (ctx.hasUI && process.env.TYPESAFE_SKILL_PLANNER_STATUS === "1") {
				const names = plan.selected.map((skill) => skill.name).join(", ") || "无";
				ctx.ui.setStatus("lystar-jev-skill-planner", `Jev Skill：${names}`);
			}
			return { systemPrompt: `${event.systemPrompt}\n${guidance}` };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debugLog(`planner failed: ${message}`);
			return;
		}
	});
}

export type { ResponseMode, SkillPlan, TypeSafeResponse };
