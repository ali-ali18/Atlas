import { asArrayLoose, isBotConfigEventObjective } from "../helpers.js";
import { parseQuestionnaireAnsweredContent, decideAction, hostAutonomyMeta } from "@workspace/shared";
import { getBotProfile, persistConversationCardFromEvent, updateBot } from "@workspace/db";
import type { BotProfileEvent, ConfirmEvent, QuestionnaireEvent, ToolContext, ToolResult } from "../types.js";
export { executeAgentMemoryTool, type AgentMemoryDeps } from "../../registry/handlers/memory.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executeDelegateTask } from "../../delegate-task.js";
import { executeDecideBotPending } from "../../bot-pending.js";
import { executeProposeBot } from "../../bot-proposal.js";
import { executeSendToBot, executeSetPrimaryBot } from "../../bot-messaging.js";
import { executeSetAutonomy } from "../../set-autonomy.js";
import { SET_ENGINE_TOOL_NAME, executeSetEngine } from "../../set-engine.js";
import { executeSetReasoningEffort } from "../../set-reasoning-effort.js";

import type { ToolFamily } from "../registry.js";

async function handleProposeBot(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeProposeBot(args, {
		userId: ctx.userId,
		botId: ctx.botId,
		conversationId: ctx.conversationId,
		runId: ctx.runId,
		origin: ctx.origin,
		recentUserTexts: ctx.recentUserTexts,
		proposals: ctx.botProposals,
		listSkills: ctx.skillStore ? (userId) => ctx.skillStore!.listAll(userId) : undefined,
		persistCard: (event) => persistConversationCardFromEvent(ctx.conversationId, event),
	});
}

async function handleProposeProfileUpdate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeProposeProfileUpdate(args, ctx);
}

async function handleSendToBot(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSendToBot(args, { userId: ctx.userId, botId: ctx.botId, runId: ctx.runId, origin: ctx.origin });
}

async function handleDecideBotPending(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeDecideBotPending(args, { userId: ctx.userId, botId: ctx.botId, conversationId: ctx.conversationId, origin: ctx.origin, jev: ctx.jev, abortSignal: ctx.abortSignal });
}

async function handleSetPrimaryBot(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const outcome = await executeSetPrimaryBot(args, {
		userId: ctx.userId, botId: ctx.botId, conversationId: ctx.conversationId, runId: ctx.runId, origin: ctx.origin,
	});
	await persistConversationCardFromEvent(ctx.conversationId, outcome.card).catch(() => undefined);
	return { summary: outcome.summary, confirmEvent: outcome.card };
}

async function handleSetAutonomy(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSetAutonomyTool(args, ctx);
}

async function handleSetEngine(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSetEngineTool(args, ctx);
}

async function handleSetReasoningEffort(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const outcome = await executeSetReasoningEffort(args, {
		userId: ctx.userId, botId: ctx.botId, origin: ctx.origin, humanTurn: ctx.humanTurn, userRequestText: ctx.userRequestText ?? "",
	});
	const card: ConfirmEvent = {
		type: "confirm",
		confirmId: `reasoning-${ctx.runId ?? "local"}-${Date.now().toString(36)}`,
		title: outcome.card.title,
		description: outcome.card.description,
		status: "approved",
	};
	await persistConversationCardFromEvent(ctx.conversationId, card).catch(() => undefined);
	return { summary: outcome.summary, confirmEvent: card };
}

async function handleDelegateTask(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeDelegateTask(args, ctx.delegation);
}

async function handleProposeQuestionnaire(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeProposeQuestionnaire(args, ctx);
}

/** Família `bots`. */
export const BOTS_TOOLS: ToolFamily = {
	"propose_bot": { group: "bots", handler: handleProposeBot },
	"propose_profile_update": { group: "bots", handler: handleProposeProfileUpdate },
	"send_to_bot": { group: "bots", handler: handleSendToBot },
	"decide_bot_pending": { group: "bots", handler: handleDecideBotPending },
	"set_primary_bot": { group: "bots", handler: handleSetPrimaryBot },
	"set_autonomy": { group: "bots", handler: handleSetAutonomy },
	[SET_ENGINE_TOOL_NAME]: { group: "bots", handler: handleSetEngine },
	"set_reasoning_effort": { group: "bots", handler: handleSetReasoningEffort },
	"delegate_task": { group: "bots", handler: handleDelegateTask },
	"propose_questionnaire": { group: "bots", handler: handleProposeQuestionnaire },
};

export async function emitQuestionnaireCard(
	ctx: ToolContext,
	event: QuestionnaireEvent,
): Promise<QuestionnaireEvent> {
	await persistConversationCardFromEvent(ctx.conversationId, event).catch(() => undefined);
	return event;
}

export async function emitBotProfileCard(
	ctx: ToolContext,
	event: BotProfileEvent,
): Promise<BotProfileEvent> {
	await persistConversationCardFromEvent(ctx.conversationId, event).catch(() => undefined);
	return event;
}


/** Decisão do gate único de autonomia para uma tool do próprio agente. */
export function hostDecision(ctx: ToolContext, tool: "propose_profile_update") {
	const policy = ctx.autonomy?.get();
	// Sem política no contexto (chamadas antigas): pergunta, como antes.
	if (!policy) return "ask";
	return decideAction(policy, hostAutonomyMeta(tool));
}

/** Escolha fixa de `propose_questionnaire` (renderiza `QuestionnaireChoice`). */
export type ProposeQuestionnaireChoice = {
	value: string;
	label?: string;
	description?: string;
};

/** Campo livre de `propose_questionnaire` (renderiza `QuestionnaireInput`). */
export type ProposeQuestionnaireInput = {
	label: string;
	placeholder?: string;
};

/** Pergunta de `propose_questionnaire` (renderiza `QuestionnaireItem`). */
export type ProposeQuestionnaireItem = {
	name: string;
	prompt: string;
	description?: string;
	required: boolean;
	multiple: boolean;
	choices: ProposeQuestionnaireChoice[];
	input?: ProposeQuestionnaireInput;
};

export type ProposeQuestionnaireProposal = {
	title: string;
	description?: string;
	items: ProposeQuestionnaireItem[];
	/** "task" (padrão) ou "onboarding" — ver descrição da tool. */
	purpose: "task" | "onboarding";
};

export const QUESTIONNAIRE_MAX_ITEMS = 10;

export const QUESTIONNAIRE_MAX_CHOICES = 10;

/**
 * Valida os args de `propose_questionnaire` (uso geral: onboarding,
 * preferências, qualquer pergunta com escolhas fixas). Exige título +
 * ao menos 1 item, cada item com prompt + ao menos 1 choice ou input
 * (sem texto estático). Lança em PT-BR para virar `tool_result failed`
 * acionável.
 */
export function parseProposeQuestionnaireArgs(
	args: Record<string, unknown>,
): ProposeQuestionnaireProposal {
	const title = String(args.title ?? "").trim().slice(0, 120);
	if (!title) {
		throw new Error("title vazio: dê um título curto ao questionário");
	}
	// Default seguro: "task" — só vira "onboarding" com o valor explícito (o
	// executor ainda força "onboarding" quando o run é um evento de config do
	// bot, e ignora esse valor fora dele).
	const purpose: "task" | "onboarding" =
		args.purpose === "onboarding" ? "onboarding" : "task";
	const descriptionRaw =
		typeof args.description === "string" && args.description.trim()
			? args.description.trim().slice(0, 500)
			: "";
	// F4 — tolerante a formato: items aceito como string JSON.
	const rawItems = asArrayLoose(args.items);
	if (rawItems.length === 0) {
		throw new Error(
			"items vazio: informe ao menos 1 pergunta com escolhas ou campo livre",
		);
	}
	const items: ProposeQuestionnaireItem[] = [];
	for (const rawEntry of rawItems.slice(0, QUESTIONNAIRE_MAX_ITEMS)) {
		// F4 — item como string JSON é parseado antes de validar.
		let entry: unknown = rawEntry;
		if (typeof entry === "string" && entry.trim()) {
			try {
				entry = JSON.parse(entry);
			} catch {
				entry = rawEntry;
			}
		}
		if (!entry || typeof entry !== "object") {
			throw new Error("item inválido: cada item exige name e prompt não-vazios");
		}
		const row = entry as Record<string, unknown>;
		const name = String(row.name ?? "").trim().slice(0, 64);
		const prompt = String(row.prompt ?? "").trim().slice(0, 500);
		if (!name || !prompt) {
			throw new Error("item inválido: cada item exige name e prompt não-vazios");
		}
		const choices: ProposeQuestionnaireChoice[] = [];
		// F4 — choices aceitos como string JSON ou string[] (vira {value, label}).
		for (const rawChoice of asArrayLoose(row.choices).slice(0, QUESTIONNAIRE_MAX_CHOICES)) {
			if (typeof rawChoice === "string") {
				const value = rawChoice.trim().slice(0, 120);
				if (!value) continue;
				choices.push({ value, label: value });
				continue;
			}
			if (!rawChoice || typeof rawChoice !== "object") continue;
			const choiceRow = rawChoice as Record<string, unknown>;
			const value = String(choiceRow.value ?? "").trim().slice(0, 120);
			if (!value) continue;
			const label =
				typeof choiceRow.label === "string" && choiceRow.label.trim()
					? choiceRow.label.trim().slice(0, 120)
					: undefined;
			const choiceDescription =
				typeof choiceRow.description === "string" && choiceRow.description.trim()
					? choiceRow.description.trim().slice(0, 200)
					: undefined;
			choices.push({
				value,
				...(label ? { label } : {}),
				...(choiceDescription ? { description: choiceDescription } : {}),
			});
		}
		let input: ProposeQuestionnaireInput | undefined;
		if (row.input && typeof row.input === "object") {
			const inputRow = row.input as Record<string, unknown>;
			const label = String(inputRow.label ?? "").trim().slice(0, 120);
			if (!label) {
				throw new Error(`item "${name}" com input sem label: informe o label do campo livre`);
			}
			const placeholder =
				typeof inputRow.placeholder === "string" && inputRow.placeholder.trim()
					? inputRow.placeholder.trim().slice(0, 200)
					: undefined;
			input = { label, ...(placeholder ? { placeholder } : {}) };
		}
		if (choices.length === 0 && !input) {
			throw new Error(
				`item "${name}" sem escolhas nem campo livre: informe ao menos 1 choice ou input (sem texto estático)`,
			);
		}
		const itemDescription =
			typeof row.description === "string" && row.description.trim()
				? row.description.trim().slice(0, 300)
				: undefined;
		items.push({
			name,
			prompt,
			...(itemDescription ? { description: itemDescription } : {}),
			required: typeof row.required === "boolean" ? row.required : true,
			multiple: row.multiple === true,
			choices,
			...(input ? { input } : {}),
		});
	}
	if (items.length === 0) {
		throw new Error(
			"items vazio: informe ao menos 1 pergunta com escolhas ou campo livre",
		);
	}
	return {
		title,
		...(descriptionRaw ? { description: descriptionRaw } : {}),
		items,
		purpose,
	};
}

/**
 * Evento de config do bot (bot-created) detectado neste run.
 * Checa `objective` (AgentRun.objective) E `lastUserText`: o marcador vem no
 * `objective` (`[bot-created] …`) ou só no JSON do user. Nunca confiar em uma
 * fonte só.
 */
export function isBotConfigEventRun(ctx: ToolContext): boolean {
	return (
		isBotConfigEventObjective(ctx.objective ?? "") ||
		isBotConfigEventObjective(ctx.lastUserText ?? "")
	);
}

export async function executeProposeQuestionnaire(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string; questionnaireEvent?: QuestionnaireEvent }> {
	const proposal = parseProposeQuestionnaireArgs(args);
	const questionnaireId = `questionnaire-${ctx.runId ?? "local"}`;
	// Rede de segurança: o run de um evento de config do bot é SEMPRE
	// onboarding, mesmo que o modelo não tenha passado purpose (ou tenha
	// errado) — nunca deixa a classificação exclusivamente a cargo do LLM.
	const purpose: "task" | "onboarding" = isBotConfigEventRun(ctx)
		? "onboarding"
		: proposal.purpose;
	const originalRequest = ctx.objective?.trim().slice(0, 500);
	const questionnaireEvent = await emitQuestionnaireCard(ctx, {
		type: "questionnaire",
		questionnaireId,
		title: proposal.title,
		...(proposal.description ? { description: proposal.description } : {}),
		items: proposal.items,
		status: "pending",
		purpose,
		...(originalRequest ? { originalRequest } : {}),
	});
	return {
		summary: `Questionário "${proposal.title}" enviado no card (${proposal.items.length} pergunta(s)). Não repita as perguntas em texto; aguarde as respostas.`,
		questionnaireEvent,
	};
}

export type ProposeProfilePatch = {
	name?: string;
	snippet?: string;
	description?: string | null;
};

export const PROFILE_FIELD_MAX_LEN = {
	name: 80,
	snippet: 140,
	description: 2000,
} as const;

export function normProfileStr(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\s+/g, " ");
	if (!normalized) return null;
	return normalized.slice(0, max);
}

/**
 * Valida os args de `propose_profile_update`. Exige ao menos 1 campo
 * não-vazio (name/snippet/description); `description: null` explícito conta
 * como limpar o briefing. Lança em PT-BR para virar `tool_result failed`
 * acionável. O diff contra o perfil atual acontece no executor.
 */
export function parseProposeProfileArgs(
	args: Record<string, unknown>,
): ProposeProfilePatch {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		throw new Error("proposta vazia: informe ao menos name, snippet ou description");
	}
	const patch: ProposeProfilePatch = {};
	const name = normProfileStr(args.name, PROFILE_FIELD_MAX_LEN.name);
	if (name) patch.name = name;
	const snippet = normProfileStr(args.snippet, PROFILE_FIELD_MAX_LEN.snippet);
	if (snippet) patch.snippet = snippet;
	if (args.description === null) {
		patch.description = null;
	} else {
		const description = normProfileStr(args.description, PROFILE_FIELD_MAX_LEN.description);
		if (description) patch.description = description;
	}
	if (Object.keys(patch).length === 0) {
		throw new Error(
			"nada para propor: informe ao menos name, snippet ou description não-vazios",
		);
	}
	return patch;
}

export async function executeProposeProfileUpdate(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string; profileEvent?: BotProfileEvent }> {
	const botId = ctx.botId;
	if (!botId) {
		throw new Error("sem bot neste run: proposta de perfil exige botId");
	}
	const patch = parseProposeProfileArgs(args);
	const current = await getBotProfile(botId, ctx.userId);
	if (!current) {
		throw new Error("bot não encontrado para proposta de perfil");
	}
	// Segunda linha de defesa (a primeira é o gate de exposição da tool em
	// `runComputerUse`): mesmo que o modelo chame a tool sem ela estar na
	// lista exposta, só deixa passar em onboarding/evento de config/resposta
	// de onboarding/pedido explícito. Bug original: toda resposta de
	// questionário virava proposta de perfil.
	if (
		current.description?.trim() &&
		!isBotConfigEventRun(ctx) &&
		parseQuestionnaireAnsweredContent(ctx.lastUserText ?? "")?.purpose !==
			"onboarding" &&
		!ctx.jevIntents?.profileChange
	) {
		return {
			summary:
				"Perfil não alterado: só no onboarding ou quando o usuário pedir.",
		};
	}
	const fields: Array<"name" | "snippet" | "description"> = [];
	const after: { name?: string; snippet?: string; description?: string | null } = {};
	if (patch.name !== undefined && patch.name !== current.name.trim()) {
		after.name = patch.name;
		fields.push("name");
	}
	if (patch.snippet !== undefined && patch.snippet !== current.snippet.trim()) {
		after.snippet = patch.snippet;
		fields.push("snippet");
	}
	const currentDescription = (current.description ?? "").trim();
	if (patch.description === null) {
		if (current.description !== null) {
			after.description = null;
			fields.push("description");
		}
	} else if (patch.description !== undefined && patch.description !== currentDescription) {
		after.description = patch.description;
		fields.push("description");
	}
	if (fields.length === 0) {
		throw new Error("sem mudanças em relação ao perfil atual: não há o que propor");
	}
	const decision = hostDecision(ctx, "propose_profile_update");
	if (decision === "block") {
		return { summary: "Perfil não alterado: a autonomia do usuário bloqueia mudanças no perfil." };
	}
	// `allow`: aplica direto e mostra o resultado (card já decidido, sem botões).
	const applyNow = decision === "allow";
	if (applyNow) {
		await updateBot(botId, after, ctx.userId);
	}
	const profileEvent = await emitBotProfileCard(ctx, {
		type: "bot-profile",
		proposalId: `profile-${ctx.runId ?? "local"}`,
		botId,
		before: {
			name: current.name,
			snippet: current.snippet,
			description: current.description,
			openRouterModel: current.openRouterModel,
		},
		after,
		fields,
		status: applyNow ? "approved" : "pending",
	});
	if (applyNow) {
		return {
			summary: `Perfil atualizado (${fields.join(", ")}). O card já mostra o resultado; não repita os valores em texto.`,
			profileEvent,
		};
	}
	return {
		summary: `Proposta de perfil (${fields.join(", ")}) enviada para confirmação humana (Aplicar/Descartar). Não repita os valores em texto; aguarde a decisão.`,
		profileEvent,
	};
}

/** `set_autonomy`: muda a política e mostra um card de resumo (já decidido). */
export async function executeSetAutonomyTool(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string; confirmEvent: ConfirmEvent }> {
	const outcome = await executeSetAutonomy(args, {
		userId: ctx.userId,
		botId: ctx.botId,
		origin: ctx.origin,
		userRequestText: ctx.userRequestText ?? "",
		jevAutonomy: ctx.jevIntents?.autonomy,
	});
	ctx.autonomy?.set(outcome.effective);
	const card: ConfirmEvent = {
		type: "confirm",
		confirmId: `autonomy-${ctx.runId ?? "local"}-${Date.now().toString(36)}`,
		title: outcome.card.title,
		description: outcome.card.description,
		status: "approved",
	};
	await persistConversationCardFromEvent(ctx.conversationId, card).catch(() => undefined);
	return { summary: outcome.summary, confirmEvent: card };
}

/** `set_engine`: liga/desliga o motor novo do bot e mostra um card de resumo (já decidido). */
export async function executeSetEngineTool(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ summary: string; confirmEvent: ConfirmEvent }> {
	const outcome = await executeSetEngine(args, {
		userId: ctx.userId,
		botId: ctx.botId,
		origin: ctx.origin,
		humanTurn: ctx.humanTurn,
		userRequestText: ctx.userRequestText ?? "",
	});
	const card: ConfirmEvent = {
		type: "confirm",
		confirmId: `engine-${ctx.runId ?? "local"}-${Date.now().toString(36)}`,
		title: outcome.card.title,
		description: outcome.card.description,
		status: "approved",
	};
	await persistConversationCardFromEvent(ctx.conversationId, card).catch(() => undefined);
	return { summary: outcome.summary, confirmEvent: card };
}
