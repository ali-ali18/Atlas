import type { ChatMessage } from "./chat.js";

/**
 * Contrato mínimo do evento `questionnaire-submitted`.
 *
 * As respostas do questionário alimentam a memória do bot para ele ficar
 * mais inteligente a cada run e evitar alucinação. O fluxo é:
 *
 * 1. Caller (web) faz `PATCH /v1/bots/:id` com `description` = briefing
 *    consolidado (estado atual) — via confirm explícito, nunca silencioso.
 * 2. Caller cria `POST /v1/runs` com `messages[0].system` = instrução
 *    per-evento curta PT-BR (ver `BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION` em
 *    `@workspace/agent-runtime`) e `messages[1].user` = JSON deste contrato
 *    (SEM texto estático pronto — o LLM lê o JSON e decide).
 * 3. O LLM consolida via tool `memory` com `target: "memory"` (botId-escopado
 *    via `resolveBotId` em `memory-entries.ts`), `category: "bot_config"` ou
 *    `"bot_evolution"`, `importance >= 0.7`, `content: "<estado>. Porquê:
 *    <motivo>"` (description = estado atual, memory = porquê/histórico).
 * 4. Runs futuros leem via `buildMemoryAugmentedMessages`
 *    (`packages/db/src/memory-context.ts`) + `renderRelevantMemoryPrompt`
 *    (`packages/db/src/memory-search.ts`): `Bot.description` (estado atual)
 *    como system + `MemoryEntry` bot_config/bot_evolution por relevância.
 *    NUNCA criar tabela `BotBriefing` — proibido.
 *
 * Anti-alucinação: antes de afirmar sobre o bot/usuário ou dizer "não sei",
 * o modelo DEVE consultar `memory_search` (fatos) e `session_search`
 * (conversas). `Bot.description` = estado atual; `MemoryEntry` = porquê.
 *
 * Idempotência / 1-run-ativo-por-conversa: reuse `clientKey`
 * (`packages/shared/src/runs.ts`, `packages/db/src/runs.ts`). Em colisão
 * P2002 o servidor faz steer no run ativo (com dedup por
 * `(runId, clientKey)` em `createRunInput`); sem `clientKey` o retry cai em
 * steer com novo seq (aceitável).
 *
 * Dedup de memória (resposta repetida NÃO duplica):
 * - Exato: `addMemoryEntry` barra `content` idêntico ("duplicado").
 * - Semântico: distância cosseno < 0.08 (`SEMANTIC_DUP_MAX_DISTANCE` em
 *   `memory-entries.ts`) barra paráfrase ("duplicado").
 * - Overflow 2200 chars (`MEMORY_CHAR_LIMIT`): `add` falha; o modelo deve
 *   usar `replace` consolidando (resume o antigo + novo num fato só,
 *   formato "<estado>. Porquê: <motivo>").
 */

export const QUESTIONNAIRE_SUBMITTED_EVENT = "questionnaire-submitted" as const;

export type QuestionnaireSubmittedEventName =
	typeof QUESTIONNAIRE_SUBMITTED_EVENT;

/** Respostas mínimas do questionário (todas opcionais, ao menos 1 preenchida). */
export type QuestionnaireAnswers = {
	/** Direção / papel escolhido (ex.: "suporte", "vendas", "pessoal"). */
	direction?: string;
	/** Detalhe livre (preferências, tom, limites). */
	detail?: string;
	/** Briefing consolidado — também vai para `Bot.description` via confirm. */
	briefing?: string;
};

/** Payload JSON que entra como `messages[].user` no AgentRun. */
export type QuestionnaireSubmittedPayload = {
	botId: string;
	event: QuestionnaireSubmittedEventName;
	answers: QuestionnaireAnswers;
	/** ISO-8601 do submit (ex.: `new Date().toISOString()`). */
	submittedAt: string;
};

function stableStringify(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function hashString(input: string): string {
	let hash = 5381;
	for (let index = 0; index < input.length; index += 1) {
		hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16);
}

function trimOrUndef(value: unknown, max = 2000): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, max);
}

/**
 * Valida o payload mínimo. Retorna `null` se inválido (caller responde 400).
 * Exige `botId` não-vazio, `event === "questionnaire-submitted"`,
 * `answers` objeto com ao menos 1 campo preenchido e `submittedAt` parseável.
 */
export function parseQuestionnaireSubmittedPayload(
	raw: unknown,
): QuestionnaireSubmittedPayload | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const botId = typeof record.botId === "string" ? record.botId.trim() : "";
	if (!botId) return null;
	if (record.event !== QUESTIONNAIRE_SUBMITTED_EVENT) return null;
	if (typeof record.answers !== "object" || record.answers === null) {
		return null;
	}
	const answersRaw = record.answers as Record<string, unknown>;
	const direction = trimOrUndef(answersRaw.direction);
	const detail = trimOrUndef(answersRaw.detail);
	const briefing = trimOrUndef(answersRaw.briefing);
	if (!direction && !detail && !briefing) return null;
	const submittedAt =
		typeof record.submittedAt === "string" ? record.submittedAt.trim() : "";
	if (!submittedAt || !Number.isFinite(Date.parse(submittedAt))) return null;
	return {
		botId,
		event: QUESTIONNAIRE_SUBMITTED_EVENT,
		answers: {
			...(direction ? { direction } : {}),
			...(detail ? { detail } : {}),
			...(briefing ? { briefing } : {}),
		},
		submittedAt,
	};
}

/** Serializa o payload para `messages[].user` (SEM texto estático). */
export function stringifyQuestionnaireSubmitted(
	payload: QuestionnaireSubmittedPayload,
): string {
	return JSON.stringify(payload);
}

/**
 * Tenta extrair o payload de um `content` user (aceita JSON puro).
 * Retorna `null` se não for `questionnaire-submitted`.
 */
export function parseQuestionnaireSubmittedContent(
	content: string,
): QuestionnaireSubmittedPayload | null {
	const trimmed = (content ?? "").trim();
	if (!trimmed.includes(QUESTIONNAIRE_SUBMITTED_EVENT)) return null;
	try {
		return parseQuestionnaireSubmittedPayload(JSON.parse(trimmed));
	} catch {
		return null;
	}
}

/**
 * `clientKey` determinístico para `POST /v1/runs` (idempotência).
 * Mesmo `botId` + mesmas `answers` => mesma chave; retry não duplica run
 * (P2002 -> steer com dedup por `(runId, clientKey)`).
 */
export function questionnaireClientKey(
	payload: QuestionnaireSubmittedPayload,
): string {
	const hash = hashString(
		stableStringify({ botId: payload.botId, answers: payload.answers }),
	);
	return `questionnaire-submitted:${payload.botId}:${hash}`.slice(0, 128);
}

/**
 * Monta `messages` para `POST /v1/runs` do questionário.
 * - `messages[0].system` = instrução per-evento curta PT-BR (fornecida pelo
 *   caller; ideal: `BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION` do agent-runtime).
 * - `messages[1].user` = JSON do contrato (SEM texto estático).
 * - `origin` deve ser `"chat"` (nunca `"routine"`: rotina stripa tools).
 */
export function buildQuestionnaireSubmittedMessages(input: {
	systemInstruction: string;
	payload: QuestionnaireSubmittedPayload;
}): ChatMessage[] {
	return [
		{ role: "system", content: input.systemInstruction },
		{ role: "user", content: stringifyQuestionnaireSubmitted(input.payload) },
	];
}

/**
 * Objective curto para `POST /v1/runs` (o `user` JSON continua sendo a fonte).
 * Ex.: `[questionnaire-submitted] Bot <id>: direção + briefing (2026-…)`.
 */
export function buildQuestionnaireSubmittedObjective(
	payload: QuestionnaireSubmittedPayload,
	botName?: string,
): string {
	const label = botName?.trim() ? `Bot "${botName.trim()}"` : `Bot ${payload.botId}`;
	const bits = [
		payload.answers.direction,
		payload.answers.detail?.slice(0, 80),
		payload.answers.briefing?.slice(0, 80),
	].filter(Boolean);
	const tail = bits.length > 0 ? `: ${bits.join(" · ")}` : "";
	return `[questionnaire-submitted] ${label}${tail}`.slice(0, 120);
}

export const QUESTIONNAIRE_ANSWERED_EVENT = "questionnaire-answered" as const;

/**
 * Propósito de um questionário: `"onboarding"` só no fluxo de configuração do
 * bot (evento `bot-created`, via
 * `BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION`); `"task"` (padrão) é qualquer
 * esclarecimento no meio de um pedido normal do usuário (lembrete, rotina,
 * skill, tarefa) — a resposta NUNCA deve virar proposta de perfil.
 */
export type QuestionnairePurpose = "task" | "onboarding";

/**
 * Instrução system do run de respostas de um questionário de ONBOARDING
 * (fluxo de configuração do bot). SEM reapresentação.
 */
export const QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION = [
	"Respostas do questionário recebidas via evento (sem texto do usuário). Responda em PT-BR.",
	"Confirme o entendimento em meia frase. Se o onboarding precisa de mais perguntas (máx. 3 no total), faça a próxima via `propose_questionnaire` (1 item). Senão encerre: o briefing/papel/tom do BOT vai só no perfil (`propose_profile_update`), NUNCA na tool `memory`. Use `memory` (target `user`) apenas para fato pessoal estável do usuário (nome, idioma, fuso, profissão), nunca para o que ele quer deste bot nem para rotinas.",
	"Ao concluir, consolide briefing/snippet e chame `propose_profile_update` para atualizar o perfil do bot (gate humano) — nunca edite o perfil diretamente.",
	"NUNCA se apresente de novo nem repita perguntas já respondidas. Não use texto estático pronto.",
].join("\n");

/**
 * @deprecated Use `QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION` (fluxo de
 * onboarding) ou `questionnaireAnswerInstruction()` (seleciona pelo
 * `purpose` do card). Mantido como alias por compatibilidade.
 */
export const QUESTIONNAIRE_ANSWER_SYSTEM_INSTRUCTION =
	QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION;

/**
 * Instrução system do run de respostas de um questionário de TAREFA (o
 * caso comum: esclarecimento no meio de um pedido). Reconecta as respostas
 * ao pedido original e proíbe tratar isso como onboarding — é a correção do
 * bug onde qualquer resposta de questionário virava proposta de perfil.
 */
export function QUESTIONNAIRE_TASK_ANSWER_INSTRUCTION(
	originalRequest?: string,
): string {
	const pedido = originalRequest?.trim();
	const linhaPedido = pedido
		? `Estas respostas completam o pedido original do usuário: "${pedido}".`
		: "Estas respostas completam um pedido anterior do usuário nesta conversa.";
	return [
		"Respostas do questionário recebidas via evento (sem texto do usuário). Responda em PT-BR.",
		linhaPedido,
		"Execute agora o pedido com as tools cabíveis (ex.: `propose_routine`, `propose_skill_change`, conectores). NÃO proponha mudança de perfil do bot (`propose_profile_update`) — isso é só para onboarding ou pedido explícito de mudar o bot.",
		"Não faça outro questionário, a menos que falte algo impossível de inferir a partir das respostas e do pedido original.",
		"NUNCA se apresente de novo nem repita perguntas já respondidas. Não use texto estático pronto.",
	].join("\n");
}

/**
 * Seleciona a instrução system do run de respostas pelo `purpose` do card.
 * Cards legados (sem `purpose` persistido) contam como `"task"` — é a opção
 * segura: nunca assume onboarding sem o evento explícito.
 */
export function questionnaireAnswerInstruction(input: {
	purpose?: QuestionnairePurpose;
	originalRequest?: string;
}): string {
	if (input.purpose === "onboarding") {
		return QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION;
	}
	return QUESTIONNAIRE_TASK_ANSWER_INSTRUCTION(input.originalRequest);
}

/** Payload JSON que entra como `messages[].user` no run de respostas. */
export type QuestionnaireAnsweredPayload = {
	questionnaireId: string;
	event: typeof QUESTIONNAIRE_ANSWERED_EVENT;
	answers: Record<string, string | string[]>;
	submittedAt: string;
	/** Propósito do card que originou a resposta (ver `QuestionnairePurpose`). */
	purpose?: QuestionnairePurpose;
	/** Pedido original do usuário que gerou o questionário (só `purpose: "task"`). */
	originalRequest?: string;
};

/**
 * Tenta extrair o payload de um `content` user (aceita JSON puro). Retorna
 * `null` se não for `questionnaire-answered`.
 */
export function parseQuestionnaireAnsweredContent(
	content: string,
): QuestionnaireAnsweredPayload | null {
	const trimmed = (content ?? "").trim();
	if (!trimmed.includes(QUESTIONNAIRE_ANSWERED_EVENT)) return null;
	try {
		const raw = JSON.parse(trimmed) as Record<string, unknown>;
		if (raw.event !== QUESTIONNAIRE_ANSWERED_EVENT) return null;
		const questionnaireId =
			typeof raw.questionnaireId === "string" ? raw.questionnaireId : "";
		if (!questionnaireId) return null;
		const purpose =
			raw.purpose === "onboarding" || raw.purpose === "task"
				? raw.purpose
				: undefined;
		const originalRequest =
			typeof raw.originalRequest === "string" && raw.originalRequest.trim()
				? raw.originalRequest.trim()
				: undefined;
		return {
			questionnaireId,
			event: QUESTIONNAIRE_ANSWERED_EVENT,
			answers:
				raw.answers && typeof raw.answers === "object"
					? (raw.answers as Record<string, string | string[]>)
					: {},
			submittedAt: typeof raw.submittedAt === "string" ? raw.submittedAt : "",
			...(purpose ? { purpose } : {}),
			...(originalRequest ? { originalRequest } : {}),
		};
	} catch {
		return null;
	}
}

function trimAnswerValue(value: unknown): string | string[] | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim().slice(0, 2000);
		return trimmed ? trimmed : undefined;
	}
	if (Array.isArray(value)) {
		const list = value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim().slice(0, 2000))
			.filter(Boolean)
			.slice(0, 20);
		if (list.length === 0) return undefined;
		return list.length > 1 ? list : (list[0] ?? "");
	}
	return undefined;
}

/**
 * Valida o body de `POST /v1/questionnaire/submit`. Retorna `null` se
 * inválido (caller responde 400). Exige `conversationId` + `questionnaireId`
 * não-vazios e `answers` com ao menos 1 valor preenchido.
 */
export function parseQuestionnaireAnswerBody(raw: unknown): {
	conversationId: string;
	questionnaireId: string;
	botId?: string;
	answers: Record<string, string | string[]>;
	clientKey?: string;
} | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const conversationId =
		typeof record.conversationId === "string" ? record.conversationId.trim() : "";
	const questionnaireId =
		typeof record.questionnaireId === "string" ? record.questionnaireId.trim() : "";
	if (!conversationId || !questionnaireId) return null;
	const botId =
		typeof record.botId === "string" && record.botId.trim()
			? record.botId.trim()
			: undefined;
	if (typeof record.answers !== "object" || record.answers === null || Array.isArray(record.answers)) {
		return null;
	}
	const answers: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(record.answers as Record<string, unknown>).slice(0, 20)) {
		if (!key || key.length > 64) continue;
		const parsed = trimAnswerValue(value);
		if (parsed !== undefined) answers[key] = parsed;
	}
	if (Object.keys(answers).length === 0) return null;
	const clientKey =
		typeof record.clientKey === "string" && record.clientKey.trim()
			? record.clientKey.trim().slice(0, 128)
			: undefined;
	return {
		conversationId,
		questionnaireId,
		...(botId ? { botId } : {}),
		answers,
		...(clientKey ? { clientKey } : {}),
	};
}

/** `clientKey` determinístico do submit (retry seguro, mesma chave). */
export function questionnaireAnswerClientKey(
	questionnaireId: string,
	answers: Record<string, string | string[]>,
): string {
	const hash = hashString(stableStringify({ questionnaireId, answers }));
	return `questionnaire-answer:${questionnaireId}:${hash}`.slice(0, 128);
}

/** Monta `messages` do run de respostas (system explícito + user JSON). */
export function buildQuestionnaireAnsweredMessages(input: {
	systemInstruction: string;
	questionnaireId: string;
	answers: Record<string, string | string[]>;
	submittedAt: string;
	/** Propósito do card (ver `QuestionnairePurpose`); embutido no JSON para o runtime gatear tools (ex.: `propose_profile_update`). */
	purpose?: QuestionnairePurpose;
	/** Pedido original que gerou o questionário (`purpose: "task"`); embutido no JSON. */
	originalRequest?: string;
}): ChatMessage[] {
	const payload: QuestionnaireAnsweredPayload = {
		questionnaireId: input.questionnaireId,
		event: QUESTIONNAIRE_ANSWERED_EVENT,
		answers: input.answers,
		submittedAt: input.submittedAt,
		...(input.purpose ? { purpose: input.purpose } : {}),
		...(input.originalRequest?.trim()
			? { originalRequest: input.originalRequest.trim() }
			: {}),
	};
	return [
		{ role: "system", content: input.systemInstruction },
		{ role: "user", content: JSON.stringify(payload) },
	];
}

/** Objective curto do run de respostas (fonte real é o user JSON). */
export function buildQuestionnaireAnsweredObjective(
	questionnaireId: string,
	names: readonly string[],
): string {
	const tail = names.length > 0 ? `: ${names.join(", ").slice(0, 80)}` : "";
	return `[questionnaire-answered] ${questionnaireId}${tail}`.slice(0, 120);
}
