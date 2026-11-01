import { isArgPresent, lessonRef, readArgPath, toolPatternMatches, type LessonRule, type LessonScope } from "@workspace/shared";

/**
 * Pipeline único de "hooks" antes de cada ferramenta: código determinístico, sem LLM, sem I/O. Roda logo antes do
 * portão de autonomia e da validação de argumentos. Duas fontes, as duas só APERTAM o comportamento:
 *   1. o portão do plano (`propose_plan` pendente): escritas voltam com erro até o usuário decidir;
 *   2. as regras das lições do bot (`required_args`, `require_prior_call`, `confirm_always`).
 * Violação vira erro da ferramenta (texto genérico em português com o id da lição) e entra no inspetor.
 */

export type HookLesson = { id: string; scope: LessonScope; scopeKey: string | null; rule: LessonRule | null };

export type PreToolCall = {
	/** Nome exposto ao modelo (`mcp__<slug>__<tool>` para conectores). */
	name: string;
	/** Nome original da tool no servidor MCP. */
	originalName?: string;
	/** Chave de escopo do conector (`mcp:<id>`). */
	connectorKey?: string;
	args: Record<string, unknown>;
	isMcp: boolean;
	/** Altera dados ou envia algo para fora (o portão do plano barra enquanto o plano espera). */
	isWrite: boolean;
	/** JSON schema dos parâmetros da tool, quando conhecido. */
	parameters?: { properties?: Record<string, unknown> } | undefined;
};

export type PreToolState = {
	lessons: readonly HookLesson[];
	/** Nomes (expostos e originais) das tools que já deram certo neste run. */
	succeeded: ReadonlySet<string>;
	/** Há um plano esperando "Aprovar plano". */
	planPending: boolean;
	/** A tool existe neste run? Uma regra que exige uma tool inexistente nunca poderia ser cumprida e é ignorada. */
	isToolAvailable: (pattern: string) => boolean;
};

export type PreToolHit = {
	source: "plan" | "rule";
	action: "blocked" | "confirm" | "skipped";
	tool: string;
	lessonId?: string;
	ref?: string;
	ruleKind?: LessonRule["kind"];
	detail?: string;
};

export type PreToolResult = {
	/** Erro devolvido ao modelo no lugar da execução. */
	error?: string;
	/** Força o cartão de confirmação mesmo que a autonomia deixasse executar. */
	forceConfirm: boolean;
	hits: PreToolHit[];
	/** Lições que bloquearam (para contar "ajudou" quando a chamada seguinte der certo). */
	blockedLessonIds: string[];
};

/** Ferramentas nativas que mudam algo fora do chat (as de conector vêm do `readOnlyHint`). */
const NATIVE_WRITE_TOOLS: ReadonlySet<string> = new Set(["email_send", "email_reply", "email_create_mailbox", "send_to_bot", "decide_bot_pending", "set_primary_bot", "set_autonomy", "set_reasoning_effort", "set_connector_tool_marks"]);

export function isNativeWriteTool(name: string): boolean {
	return NATIVE_WRITE_TOOLS.has(name);
}

export const PLAN_PENDING_ERROR = "plano aguardando aprovação: não execute escritas até o usuário aprovar o plano. Leituras continuam permitidas; se precisar de algo, pergunte no plano.";

function lessonApplies(lesson: HookLesson, call: PreToolCall): boolean {
	if (lesson.scope === "bot") return true;
	if (lesson.scope === "connector") return lesson.scopeKey !== null && lesson.scopeKey === call.connectorKey;
	return lesson.scopeKey !== null && (lesson.scopeKey === call.name || lesson.scopeKey === call.originalName);
}

export function runPreToolHooks(call: PreToolCall, state: PreToolState): PreToolResult {
	const hits: PreToolHit[] = [];
	const errors: string[] = [];
	const blockedLessonIds: string[] = [];
	let forceConfirm = false;

	if (state.planPending && call.isWrite) {
		hits.push({ source: "plan", action: "blocked", tool: call.name });
		errors.push(PLAN_PENDING_ERROR);
	}

	for (const lesson of state.lessons) {
		const rule = lesson.rule;
		if (!rule || !lessonApplies(lesson, call) || !toolPatternMatches(rule.tool, call.name, call.originalName)) continue;
		const ref = lessonRef(lesson.id);
		const base = { source: "rule" as const, tool: call.name, lessonId: lesson.id, ref, ruleKind: rule.kind };
		if (rule.kind === "confirm_always") {
			if (call.isMcp) {
				forceConfirm = true;
				hits.push({ ...base, action: "confirm" });
			}
			continue;
		}
		if (rule.kind === "required_args") {
			const declared = call.parameters?.properties;
			// Campo que a tool nem declara não pode ser fornecido: a regra não se aplica (senão bloquearia para sempre).
			const applicable = rule.fields.filter((field) => !declared || Object.prototype.hasOwnProperty.call(declared, field.split(".")[0]!));
			if (applicable.length === 0) {
				hits.push({ ...base, action: "skipped", detail: "campo fora do schema da tool" });
				continue;
			}
			const missing = applicable.filter((field) => !isArgPresent(readArgPath(call.args, field)));
			if (missing.length === 0) continue;
			hits.push({ ...base, action: "blocked", detail: `faltam: ${missing.join(", ")}` });
			blockedLessonIds.push(lesson.id);
			errors.push(
				`Regra da lição [${ref}]: faltam campos obrigatórios em "${call.name}": ${missing.join(", ")}${rule.note ? ` (${rule.note})` : ""}. Obtenha os valores (com o usuário ou numa leitura) e chame de novo.`,
			);
			continue;
		}
		// require_prior_call
		if (!state.isToolAvailable(rule.requires)) {
			hits.push({ ...base, action: "skipped", detail: "a chamada exigida não existe neste run" });
			continue;
		}
		if ([...state.succeeded].some((name) => toolPatternMatches(rule.requires, name))) continue;
		hits.push({ ...base, action: "blocked", detail: `antes: ${rule.requires}` });
		blockedLessonIds.push(lesson.id);
		errors.push(`Regra da lição [${ref}]: antes de chamar "${call.name}" é preciso uma chamada bem-sucedida a "${rule.requires}" neste run. Faça essa chamada primeiro e depois repita.`);
	}

	return { ...(errors.length > 0 ? { error: errors.join("\n") } : {}), forceConfirm: forceConfirm && errors.length === 0, hits, blockedLessonIds };
}
