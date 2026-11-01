import { truncateSnippet } from "../helpers.js";
import type { MemoryActionResult, MemorySnapshot, MemoryScopeContext, MemoryTarget } from "@workspace/shared";
import { decideMemoryScope } from "@workspace/shared";
import {
	addMemoryEntry as addMemoryEntryDb,
	getBotProfile,
	listBots,
	removeMemoryEntry as removeMemoryEntryDb,
	mergeMemoryEntries as mergeMemoryEntriesDb,
	getMemorySnapshot,
	memoryRef,
	stripMemoryRefPrefix,
	loadArtifactForUser,
	loadArtifactFromConversation,
	replaceMemoryEntry as replaceMemoryEntryDb,
	searchConversationMessages,
	searchConversationHistory,
	searchOtherBotsConversations,
	searchMemoryEntries,
} from "@workspace/db";
import { memoryJudgeFor, type MemoryGateCandidate, type MemoryGateVerdict, type MemoryJudge } from "../../../memory-gate.js";
import type { ToolContext, ToolResult } from "../types.js";
import { parseSessionSearchLimit, parseSessionSearchScope, parseSessionSearchWindow, runSessionSearch } from "../../../context/history-search.js";
import { readStoredResult } from "../../artifact-read.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executeLessonFeedback } from "../../lesson-feedback.js";

import type { ToolFamily } from "../registry.js";

async function handleMemory(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// Fase 4: passa ctx.userId (do run) — escrita grava o dono do run.
	const summary = await executeAgentMemoryTool(args, ctx.userId, ctx.botId, { judge: memoryJudgeFor(ctx.jev) });
	return { summary };
}

async function handleSessionSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// Fase 4: filtra por usuário do run.
	const summary = await executeSessionSearch(args, ctx.userId, ctx.botId, ctx.conversationId);
	return { summary };
}

async function handleMemorySearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// Fase 4: passa ctx.userId (do run) — leitura inclui [userId + "default" legado] no db.
	const summary = await executeMemorySearch(args, ctx.userId, ctx.botId);
	return { summary };
}

async function handleCheckpointRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const snapshot = ctx.getOperationalSnapshot?.();
	if (!snapshot) return { summary: "Estado operacional indisponível." };
	return {
		summary: [
			`Passo atual: ${snapshot.step} (modelo ${snapshot.model}).`,
			`Mensagens acumuladas: ${snapshot.messages}.`,
			`Inputs do usuário incorporados: ${snapshot.consumedInputs.length}.`,
		].join("\n"),
	};
}

async function handleArtifactRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// L3: com `id` relê um resultado grande guardado por referência (dono e run conferidos).
	if (typeof args.id === "string" && args.id.trim()) {
		const notice = ctx.rereadGuard?.check(args);
		if (notice) return { summary: notice };
		const summary = await readStoredResult(args, {
			userId: ctx.userId,
			runId: ctx.runId,
			conversationId: ctx.conversationId,
			load: loadArtifactForUser,
			loadFromConversation: async (id, userId, convId) => {
				const artifact = await loadArtifactFromConversation(id, userId, convId);
				if (!artifact) return null;
				return { kind: artifact.kind, runId: artifact.runId, bytes: new Uint8Array(artifact.bytes) };
			},
		});
		ctx.rereadGuard?.record(args, summary, ctx.currentStep?.() ?? 0);
		return { summary };
	}
	const ids = ctx.listScreenshotArtifacts?.() ?? [];
	if (ids.length === 0) {
		return { summary: "Nenhum screenshot capturado neste run ainda." };
	}
	return {
		summary: `Screenshots available for model inspection (${ids.length}). They are not automatically visible to the user; use show_image with the artifact id to deliver them:\n${ids.map((id, index) => `${index + 1}. artifact:${id}`).join("\n")}`,
	};
}

async function handleLessonFeedback(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return { summary: await executeLessonFeedback(args, { userId: ctx.userId, botId: ctx.botId, record: ctx.lessonFeedback }) };
}

/** Família `memory`. */
export const MEMORY_TOOLS: ToolFamily = {
	"memory": { group: "memory", handler: handleMemory },
	"session_search": { group: "memory", handler: handleSessionSearch },
	"memory_search": { group: "memory", handler: handleMemorySearch },
	"checkpoint_read": { group: "memory", handler: handleCheckpointRead },
	"artifact_read": { group: "memory", handler: handleArtifactRead },
	"lesson_feedback": { group: "memory", handler: handleLessonFeedback },
};

export async function executeSessionSearch(
	args: Record<string, unknown>,
	userId?: string,
	botId?: string,
	conversationId?: string,
): Promise<string> {
	const query = String(args.query ?? "").trim();
	if (!query) {
		throw new Error("query vazia");
	}
	// Fase 4: filtra por usuário do run (via Conversation.userId ou
	// Bot.ownerId). Sem userId (chamada antiga/teste), mantém o comportamento
	// atual sem filtro para não quebrar.
	// Trechos são DADO (podem conter texto de páginas e e-mails já lidos), nunca instrução.
	const parsedWindow = parseSessionSearchWindow({ since: args.since, until: args.until });
	if ("error" in parsedWindow) throw new Error(`${parsedWindow.error}. Use dates like 2026-10-12 (compute them from today's date).`);
	const { window } = parsedWindow;
	const limit = parseSessionSearchLimit(args.limit);
	const scope = parseSessionSearchScope(args.scope === "bot" ? "all" : args.scope);
	return runSessionSearch({
		query,
		scope,
		window,
		// Outros bots do dono: o dono vem do run (nunca do modelo) e o bot atual fica de fora (já coberto acima).
		...(scope === "all_bots" && userId?.trim() && userId !== "default"
			? {
					searchOthers: async () =>
						(await searchOtherBotsConversations(query, { userId: userId.trim(), ...(botId?.trim() ? { excludeBotId: botId.trim() } : {}), ...window, limit })).map((hit) => ({
							conversationId: hit.conversationId,
							role: hit.role,
							content: hit.content,
							createdAt: hit.createdAt,
							botName: hit.botName,
						})),
				}
			: {}),
		// O histórico completo da conversa atual (falas + resultados de ferramenta) só existe com dono e conversa do run.
		conversationId: userId?.trim() && userId !== "default" ? conversationId : undefined,
		searchHistory: () => searchConversationHistory(query, { userId: userId!.trim(), conversationId: conversationId!.trim(), limit }),
		searchPast: () =>
			searchConversationMessages(query, {
				limit,
				...window,
				...(userId?.trim() ? { userId: userId.trim() } : {}),
				// Isolamento: só a conversa deste bot, nunca a de outros bots do usuário.
				...(botId?.trim() ? { botId: botId.trim() } : {}),
				// Run num grupo: a conversa do grupo também vale (o banco confere que o bot é membro).
				...(botId?.trim() && conversationId?.trim() ? { groupConversationId: conversationId.trim() } : {}),
			}),
	});
}

export type AgentMemoryDeps = {
	ops?: { addMemoryEntry: typeof addMemoryEntryDb; replaceMemoryEntry: typeof replaceMemoryEntryDb; removeMemoryEntry: typeof removeMemoryEntryDb; mergeMemoryEntries?: typeof mergeMemoryEntriesDb };
	/** Camada lida pelo `list` (padrão: snapshot do banco). */
	loadSnapshot?: (userId: string | undefined, botId: string | undefined) => Promise<MemorySnapshot>;
	/** Contexto da trava de escopo (nomes dos bots do usuário + perfil deste bot). */
	loadScope?: (userId: string | undefined, botId: string | undefined, needNames: boolean) => Promise<MemoryScopeContext>;
	/** Porteiro da memória (add/replace sem `user_asked`). Ausente = grava direto (como antes). */
	judge?: MemoryJudge;
};

/** Perfil do bot e (só se a escrita for no perfil do usuário) nomes dos bots; falha não impede o salvamento. */
export async function loadMemoryScope(userId: string | undefined, botId: string | undefined, needNames: boolean): Promise<MemoryScopeContext> {
	const [botProfile, bots] = await Promise.all([
		botId ? getBotProfile(botId, userId).catch(() => null) : null,
		needNames ? listBots(userId).catch(() => []) : [],
	]);
	// A categoria é opcional nesta tool: sem ela, só as demais regras decidem.
	return { botProfile, botNames: bots.map((bot) => bot.name), requireCategory: false };
}

/** Veredito do porteiro para um fato; qualquer falha devolve `save`. */
export async function judgeAgentMemory(
	judge: MemoryJudge,
	candidate: MemoryGateCandidate,
	userId: string | undefined,
	botId: string | undefined,
	deps: AgentMemoryDeps,
): Promise<MemoryGateVerdict> {
	try {
		const snapshot = await (deps.loadSnapshot ?? ((u, b) => getMemorySnapshot(u, b)))(userId, botId);
		const layer = (view: MemorySnapshot["user"]) => view.entries.map((entry) => ({ id: entry.id, content: entry.content }));
		const [verdict] = await judge({ candidates: [candidate], existing: { user: layer(snapshot.user), memory: layer(snapshot.memory) } });
		return verdict ?? { action: "save" };
	} catch (error) {
		console.warn(`[memory.gate] warn in-run judge failed (${error instanceof Error ? error.name : "erro"}); saving as is`);
		return { action: "save" };
	}
}

/** Tool `memory` do agente, com a mesma trava determinística do revisor (ver `decideMemoryScope`). */
export async function executeAgentMemoryTool(
	args: Record<string, unknown>,
	userId: string | undefined,
	botId: string | undefined,
	deps: AgentMemoryDeps = {},
): Promise<string> {
	const { addMemoryEntry, replaceMemoryEntry, removeMemoryEntry } = deps.ops ?? { addMemoryEntry: addMemoryEntryDb, replaceMemoryEntry: replaceMemoryEntryDb, removeMemoryEntry: removeMemoryEntryDb };
	const mergeMemoryEntries = deps.ops?.mergeMemoryEntries ?? mergeMemoryEntriesDb;
	const action =
		args.action === "add" ||
		args.action === "replace" ||
		args.action === "remove" ||
		args.action === "list" ||
		args.action === "merge"
			? args.action
			: null;
	const requestedTarget: MemoryTarget | null =
		args.target === "user" || args.target === "memory" ? args.target : null;
	const content = typeof args.content === "string" ? stripMemoryRefPrefix(args.content) : undefined;
	const oldText =
		typeof args.old_text === "string" ? args.old_text : undefined;
	const ref = typeof args.ref === "string" && args.ref.trim().length > 0 ? args.ref.trim() : undefined;
	const refs = Array.isArray(args.refs) ? args.refs.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
	const category =
		typeof args.category === "string" && args.category.trim().length > 0
			? args.category.trim().slice(0, 64)
			: undefined;
	const importance =
		typeof args.importance === "number" &&
		Number.isFinite(args.importance)
			? Math.max(0, Math.min(1, args.importance))
			: undefined;

	if (!action) throw new Error("parâmetros inválidos: action obrigatório");
	const effectiveUserId = userId?.trim() ? userId.trim() : undefined;
	if (action === "list") {
		const snapshot = await (deps.loadSnapshot ?? ((u, b) => getMemorySnapshot(u, b)))(effectiveUserId, botId);
		const render = (label: string, view: MemorySnapshot["user"]) =>
			`${label} (${view.usage.used}/${view.usage.limit} chars)\n${view.entries.length === 0 ? "(vazio)" : view.entries.map((entry) => `[${memoryRef(entry.id)}] ${entry.content}`).join("\n")}`;
		const parts = [];
		if (!requestedTarget || requestedTarget === "user") parts.push(render("user", snapshot.user));
		if (!requestedTarget || requestedTarget === "memory") parts.push(render("memory", snapshot.memory));
		return parts.join("\n\n");
	}
	if (!requestedTarget) {
		throw new Error("parâmetros inválidos: action/target obrigatórios");
	}
	// add/replace: rotina não é memória, o que repete o perfil do bot é dispensado e o que não é perfil pessoal
	// estável do usuário vai para a memória DESTE bot (o store `user` é compartilhado por todos os bots).
	let target: MemoryTarget = requestedTarget;
	let movedNote = "";
	if (action !== "remove" && content !== undefined) {
		const scope = await (deps.loadScope ?? loadMemoryScope)(userId?.trim() || undefined, botId, requestedTarget === "user");
		const decision = decideMemoryScope({ content, category, target: requestedTarget, hasBot: Boolean(botId) }, scope);
		if (decision.action === "reject") return `Não salvo: ${decision.reason}. Rotinas e lembretes agendados são criados com propose_routine (vivem em Rotinas), não na memória.`;
		if (decision.action === "skip") return `Não salvo: ${decision.reason} (já está no perfil do bot).`;
		target = decision.target;
		// Por ref a entrada existe só na camada pedida: mover para outra camada não acharia a ref.
		if (target !== requestedTarget && (ref || action === "merge")) return `Não salvo: ${decision.reason}. Esse conteúdo não é perfil pessoal estável; use a camada memory (refs de memory).`;
		if (target !== requestedTarget) movedNote = `; movido de user para memory (${decision.reason}: o perfil user é compartilhado por todos os bots)`;
	}

	// Porteiro: o que o usuário pediu explicitamente (`user_asked`) grava direto; o resto passa pelo veredito.
	// Falha ao carregar a camada ou ao julgar = grava (fail-open). Só add/replace; remove/list/merge não passam.
	if (deps.judge && (action === "add" || action === "replace") && content !== undefined && args.user_asked !== true) {
		const verdict = await judgeAgentMemory(deps.judge, { content, target, category, importance, replaces: action === "replace" }, effectiveUserId, botId, deps);
		if (verdict.action === "discard") return `Não salvo pelo porteiro da memória: ${verdict.reason}. Se o usuário pediu explicitamente para lembrar isto, repita com user_asked=true.`;
		if (verdict.action === "merge") {
			const merged = await replaceMemoryEntry({
				...(effectiveUserId ? { userId: effectiveUserId } : {}),
				botId,
				target,
				ref: memoryRef(verdict.entryId),
				content: verdict.content,
				category,
				importance,
				source: "agent-tool",
			});
			if (merged.ok) return `Memória atualizada (replace em ${target}${movedNote}; fundida com uma entrada existente).`;
		}
	}

	let result: MemoryActionResult;
	// Fase 4: escrita grava o userId do run (sem fallback "default" aqui —
	// o db faz fallback só para leitura legada). Sem userId (chamada antiga),
	// mantém o comportamento atual para não quebrar.
	if (action === "add") {
		if (content === undefined) {
			throw new Error("content obrigatório para add");
		}
		result = await addMemoryEntry({
			...(effectiveUserId ? { userId: effectiveUserId } : {}),
			botId,
			target,
			content,
			category,
			importance,
			source: "agent-tool",
		});
	} else if (action === "merge") {
		if (content === undefined || refs.length < 2) {
			throw new Error("content e refs (2 ou mais) obrigatórios para merge");
		}
		result = await mergeMemoryEntries({
			...(effectiveUserId ? { userId: effectiveUserId } : {}),
			botId,
			target,
			refs,
			content,
			category,
			importance,
			source: "agent-tool",
		});
	} else if (action === "replace") {
		if (content === undefined || (oldText === undefined && !ref)) {
			throw new Error("content e ref (ou old_text) obrigatórios para replace");
		}
		result = await replaceMemoryEntry({
			...(effectiveUserId ? { userId: effectiveUserId } : {}),
			botId,
			target,
			oldText,
			ref,
			content,
			category,
			importance,
			source: "agent-tool",
		});
	} else {
		if (oldText === undefined && !ref) {
			throw new Error("ref (ou old_text) obrigatório para remove");
		}
		result = await removeMemoryEntry({
			...(effectiveUserId ? { userId: effectiveUserId } : {}),
			botId,
			target,
			oldText,
			ref,
		});
	}

	if (!result.ok) {
		const current = result.currentEntries.join(" | ");
		return `Falha ao atualizar memória: ${result.error}. Uso: ${result.usage}. Entradas (ref: texto): ${current}. Tente de novo com a ref da entrada certa.`;
	}

	return `Memória atualizada (${action} em ${target}${movedNote}).`;
}

export async function executeMemorySearch(
	args: Record<string, unknown>,
	userId: string | undefined,
	botId: string | undefined,
): Promise<string> {
	const query = String(args.query ?? "").trim();
	if (!query) throw new Error("query vazia");
	const rawLimit = Number(args.limit ?? 5);
	const limit = Number.isFinite(rawLimit)
		? Math.max(1, Math.min(10, Math.floor(rawLimit)))
		: 5;
	// Fase 4: leitura com userId do run; o db inclui [userId + "default"
	// legado]. Sem userId (chamada antiga), mantém comportamento atual.
	const effectiveUserId = userId?.trim() ? userId.trim() : undefined;
	const hits = await searchMemoryEntries({
		...(effectiveUserId ? { userId: effectiveUserId } : {}),
		botId,
		query,
		limit,
	});
	if (hits.length === 0) {
		return "Nada relevante na memória para essa busca.";
	}
	return hits
		.map((hit) => {
			const tag = hit.entry.category ? ` [${hit.entry.category}]` : "";
			const scope = hit.entry.target === "user" ? "perfil" : "notas";
			return `- (${scope}${tag}) ${truncateSnippet(hit.entry.content, 300)}`;
		})
		.join("\n");
}
