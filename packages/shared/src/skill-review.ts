/**
 * Revisão de skill depois de uma tarefa bem-sucedida e complexa (aprendizado procedural). Funções puras: quando
 * vale revisar, como ler a decisão do revisor e as travas de proveniência. O job (worker) faz o I/O.
 */
import { copiesFrom, lessonDataTokens, normalizeForMatch } from "./lessons.js";
import { validateSkillFields } from "./skill-markdown.js";

/**
 * Limiares (heurística do Hermes: tarefa de 5+ chamadas de ferramenta). Abaixo disso o run é recado simples, não
 * procedimento. Cobre "complexa" sem custar uma chamada de modelo em toda conversa.
 */
export const SKILL_REVIEW_MIN_TOOL_CALLS = 5;
export const SKILL_REVIEW_MIN_DISTINCT_TOOLS = 2;
/** Teto de skills que a revisão automática cria ou reescreve por conta em 24 h (freio de custo e de ruído). */
export const SKILL_REVIEW_DAILY_CAP = 5;

export type SkillReviewGateInput = {
	origin: string;
	hasBot: boolean;
	hasConversation: boolean;
	groupRun: boolean;
	onboardingRun: boolean;
	/** O run bateu no limite de passos/orçamento em vez de concluir. */
	hitWall: boolean;
	/** Chamadas de ferramenta que terminaram bem. */
	completedToolCalls: number;
	failedToolCalls: number;
	/** Ferramentas diferentes usadas; ausente = ainda não sabido (o job confere de novo com os dados completos). */
	distinctTools?: number;
	/** O próprio agente já salvou ou propôs uma skill neste run (nada a aprender por cima). */
	skillWrittenInRun?: boolean;
};

/** Decisão pura: este run merece uma revisão de skill? Só chat, concluído, com trabalho de vários passos. */
export function shouldReviewForSkill(input: SkillReviewGateInput): boolean {
	if (input.origin !== "chat" || !input.hasBot || !input.hasConversation || input.groupRun || input.onboardingRun) return false;
	if (input.hitWall || input.skillWrittenInRun) return false;
	if (input.completedToolCalls < SKILL_REVIEW_MIN_TOOL_CALLS) return false;
	// Run dominado por falhas não é um procedimento que funcionou.
	if (input.failedToolCalls * 2 > input.completedToolCalls) return false;
	if (input.distinctTools !== undefined && input.distinctTools < SKILL_REVIEW_MIN_DISTINCT_TOOLS) return false;
	return true;
}

export type SkillReviewDecision =
	| { decision: "none"; reason: string }
	| { decision: "create" | "update"; name: string; description: string; body: string; tools: string[]; basedOn: string[]; reason: string };

function jsonObjectOf(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Saída do revisor → decisão validada. Qualquer coisa fora do formato (ou skill que não passa em
 * `validateSkillFields`) vira `none`: nunca "conserta" conteúdo.
 */
export function parseSkillReviewDecision(text: string): SkillReviewDecision {
	const row = jsonObjectOf(text);
	const none = (reason: string): SkillReviewDecision => ({ decision: "none", reason });
	if (!row) return none("resposta fora do formato");
	const kind = row.decision;
	const reason = typeof row.reason === "string" ? row.reason.trim().slice(0, 200) : "";
	if (kind !== "create" && kind !== "update") return none(reason || "nada a aprender");
	const skill = row.skill && typeof row.skill === "object" && !Array.isArray(row.skill) ? (row.skill as Record<string, unknown>) : null;
	if (!skill) return none("sem skill na resposta");
	const parsed = validateSkillFields({ name: skill.name, description: skill.description, body: skill.body, tools: skill.tools });
	if (!parsed.ok) return none(`skill inválida: ${parsed.errors.join(" ")}`.slice(0, 200));
	const basedOn = Array.isArray(row.basedOn) ? row.basedOn.filter((item): item is string => typeof item === "string").map((item) => item.trim()).slice(0, 20) : [];
	return { decision: kind, ...parsed.skill, basedOn, reason };
}

/** Payload do job `skill.review`: um run de chat concluído. */
export type SkillReviewJobPayload = {
	userId: string;
	botId: string;
	conversationId: string;
	runId: string;
};

export type SkillReviewJobResult = {
	status: "skipped" | "reviewed";
	reason?: string;
	/** O que a revisão fez: nada, criou skill, atualizou skill ou propôs por cartão. */
	outcome?: "none" | "created" | "updated" | "proposed";
	skill?: string;
	maintenance?: { model: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number };
};

export type SkillReviewSlice = {
	/** Falas do usuário na conversa analisada. */
	userTexts: readonly string[];
	/** Todo texto vindo de ferramenta no run (dado não confiável). */
	toolTexts: readonly string[];
	/** Nomes das tools que o run chamou com sucesso. */
	toolNames: readonly string[];
};

/**
 * Motivo para recusar a skill proposta, ou null. A skill é instrução permanente: não pode nascer de conteúdo de
 * ferramenta (página, e-mail, arquivo). Exige (1) que se apoie em tools que o run de fato usou, (2) nenhum trecho
 * copiado de texto de ferramenta e (3) nenhum dado concreto (URL, e-mail, telefone) que o usuário não escreveu.
 */
export function skillProvenanceProblem(skill: { body: string; description: string; basedOn: readonly string[] }, slice: SkillReviewSlice): string | null {
	const used = new Set(slice.toolNames);
	if (skill.basedOn.length === 0) return "sem as tools em que a skill se apoia";
	if (!skill.basedOn.every((name) => used.has(name))) return "cita tool que o run não usou";
	const text = `${skill.description}\n${skill.body}`;
	if (copiesFrom(text, slice.toolTexts)) return "copia texto de ferramenta";
	const allowed = slice.userTexts.map(normalizeForMatch).join(" \n ");
	for (const token of lessonDataTokens(text)) {
		if (!allowed.includes(token)) return "dado concreto (e-mail, URL ou telefone) que o usuário não escreveu";
	}
	return null;
}
