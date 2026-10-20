import {
	PENDING_CATEGORY,
	PENDING_RESOLVED_CATEGORY,
	REFLECTION_MAX_CARDS,
	REFLECTION_MAX_STEPS,
	REFLECTION_MAX_TOKENS,
	REFLECTION_SYSTEM_PROMPT,
	buildReflectionContext,
	buildRecheckObjective,
	decideReflectionOutcome,
	findDuplicatePending,
	formatOpenPending,
	formatReflectionMessage,
	isOpenPending,
	languageInstruction,
	markPendingResolved,
	notePendingChecked,
	parseRecheckResult,
	pickPendingsToRecheck,
	reflectionFailureLogLine,
	toReflectionFailure,
	type BotLanguage,
	type PendingEntry,
	type ReflectionFailureStage,
	type ReflectionChange,
	type ReflectionInput,
	type ReflectionRef,
} from "@workspace/shared";
import type { ChatTool, LlmMessage } from "@workspace/llm";
import { completeChatWithTools } from "@workspace/llm";

/**
 * Reflexão do orquestrador. Duas fases, ambas baratas e limitadas:
 *  A) um laço curto de ferramentas (modelo de manutenção) que junta/remove memórias, grava fatos e
 *     pendências NA MEMÓRIA DO ORQUESTRADOR e propõe cartões de perfil;
 *  B) uma verificação das pendências mais importantes por um run só com ferramentas de leitura.
 * Tudo que toca o banco entra por `ReflectionPorts` (testável sem Postgres). Só o orquestrador
 * recebe conhecimento cruzado: `save_fact`/`save_pending` não aceitam bot de destino.
 */

export type MemoryRow = { id: string; botId: string | null; target: string; content: string; category: string | null; importance: number | null };

export type ReflectionPorts = {
	getOwnedMemory(userId: string, id: string): Promise<MemoryRow | null>;
	updateOwnedMemory(userId: string, id: string, patch: { content: string; category?: string; importance?: number; validUntil?: Date | null; source?: string }): Promise<boolean>;
	deleteOwnedMemory(userId: string, id: string): Promise<boolean>;
	addMemory(input: { userId: string; botId: string; content: string; category?: string; importance?: number; source?: string }): Promise<{ ok: boolean; error?: string; entry?: { id: string }; skipped?: string }>;
	appendCard(input: { userId: string; conversationId: string; proposalId: string; botId: string; after: { name?: string; snippet?: string; description?: string | null } }): Promise<{ ok: true; fields: string[] } | { ok: false; reason: string }>;
	/** Cria e executa o run de verificação (só leitura); devolve o texto final ou null. */
	runRecheck(input: { userId: string; botId: string; objective: string }): Promise<{ status: string; text: string | null } | null>;
};

export type ReflectionContext = {
	userId: string;
	primaryBotId: string;
	primaryBotName: string;
	conversationId: string | null;
	rowId: string;
	now: Date;
	timeZone: string;
	refs: Map<string, ReflectionRef>;
	botNames: Map<string, string>;
	/** Pendências abertas do orquestrador (ref M# -> entrada), mantidas ao longo da execução. */
	pending: Map<string, PendingEntry>;
	changes: ReflectionChange[];
	cardsUsed: number;
	finished: { summary: string; important: boolean } | null;
	ports: ReflectionPorts;
};

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatTool => ({
	type: "function",
	function: { name, description, parameters: { type: "object", properties, required } },
});

export const REFLECTION_TOOLS: ChatTool[] = [
	tool(
		"save_pending",
		"Registra na SUA memória uma pendência real do usuário que ficou sem desfecho (problema ou pedido).",
		{
			content: { type: "string", description: "Uma frase: o que o usuário pediu/enfrentava e que não foi confirmado como resolvido." },
			origin_bot: { type: "string", description: "Referência do bot de origem (B1, B2…)." },
			importance: { type: "number", description: "0 a 1 (>= 0.7 para o que bloqueia ou custa dinheiro)." },
		},
		["content", "origin_bot"],
	),
	tool("resolve_pending", "Marca como resolvida uma pendência que você já acompanha (ref M#), quando as conversas mostram o desfecho.", { ref: { type: "string" }, finding: { type: "string" } }, ["ref"]),
	tool(
		"save_fact",
		"Grava na SUA memória (e só nela) um fato útil vindo de outro bot ou de um evento. Cite a origem e a data.",
		{ content: { type: "string" }, origin: { type: "string", description: "Bot ou evento de origem, ex.: Grok Bot, webhook do Dokploy." }, category: { type: "string" }, importance: { type: "number" } },
		["content", "origin"],
	),
	tool(
		"merge_memories",
		"Une memórias duplicadas do MESMO bot (ou do perfil user) em uma só. As refs precisam ser do mesmo dono e camada.",
		{ refs: { type: "array", items: { type: "string" }, description: "Duas ou mais refs M#." }, content: { type: "string", description: "Texto final unido." } },
		["refs", "content"],
	),
	tool("remove_memory", "Apaga uma memória vencida, obsoleta ou contraditória.", { ref: { type: "string" }, reason: { type: "string" } }, ["ref", "reason"]),
	tool(
		"suggest_bot_profile",
		"Propõe (cartão para o usuário aprovar) um novo perfil para um bot. Nada é aplicado sem aprovação.",
		{ bot_ref: { type: "string", description: "B1, B2…" }, name: { type: "string" }, snippet: { type: "string" }, description: { type: "string" }, reason: { type: "string" } },
		["bot_ref", "reason"],
	),
	tool("finish", "Encerra a reflexão com o resumo para o usuário.", { summary: { type: "string" }, important: { type: "boolean" } }, ["summary", "important"]),
];

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw || "{}");
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const str = (value: unknown, max = 600): string | undefined => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : undefined);
const num01 = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined);
const err = (error: string) => ({ ok: false, result: { ok: false, error } });
const good = (result: Record<string, unknown> = {}) => ({ ok: true, result: { ok: true, ...result } });

function memoryRef(ctx: ReflectionContext, ref: unknown): Extract<ReflectionRef, { kind: "memory" }> | null {
	const found = typeof ref === "string" ? ctx.refs.get(ref.trim().toUpperCase()) : undefined;
	return found?.kind === "memory" ? found : null;
}

export async function executeReflectionTool(name: string, rawArgs: string, ctx: ReflectionContext): Promise<{ ok: boolean; result: unknown }> {
	const args = parseArgs(rawArgs);
	const { ports, userId } = ctx;
	try {
		switch (name) {
			case "save_pending": {
				const text = str(args.content, 300);
				const originRef = typeof args.origin_bot === "string" ? ctx.refs.get(args.origin_bot.trim().toUpperCase()) : undefined;
				const origin = originRef?.kind === "bot" ? (ctx.botNames.get(originRef.id) ?? "outro bot") : str(args.origin_bot, 60);
				if (!text || !origin) return err("content e origin_bot obrigatórios");
				if (findDuplicatePending([...ctx.pending.values()], text)) return good({ skipped: "já acompanhada" });
				const content = formatOpenPending(text, origin, ctx.now, ctx.timeZone);
				const added = await ports.addMemory({ userId, botId: ctx.primaryBotId, content, category: PENDING_CATEGORY, importance: num01(args.importance) ?? 0.7, source: `reflexao: ${origin}` });
				if (!added.ok) return added.error === "duplicado" ? good({ skipped: "duplicado" }) : err(added.error ?? "falhou");
				const id = added.entry?.id ?? `new-${ctx.pending.size}`;
				ctx.pending.set(`NEW${id}`, { id, content, category: PENDING_CATEGORY, importance: num01(args.importance) ?? 0.7, createdAt: ctx.now, updatedAt: ctx.now });
				ctx.changes.push({ op: "pending-save", botId: ctx.primaryBotId, id, content, origin });
				return good();
			}
			case "resolve_pending": {
				const ref = typeof args.ref === "string" ? args.ref.trim().toUpperCase() : "";
				const entry = ctx.pending.get(ref);
				if (!entry || !isOpenPending(entry)) return err("ref não é uma pendência aberta");
				const after = markPendingResolved(entry.content, ctx.now, ctx.timeZone, str(args.finding, 160));
				const validUntil = new Date(ctx.now.getTime() + 14 * 86_400_000);
				if (!(await ports.updateOwnedMemory(userId, entry.id, { content: after, category: PENDING_RESOLVED_CATEGORY, importance: 0.2, validUntil }))) return err("entrada não encontrada");
				ctx.pending.delete(ref);
				ctx.changes.push({ op: "pending-resolve", botId: ctx.primaryBotId, id: entry.id, before: entry.content, after, how: "conversa" });
				return good();
			}
			case "save_fact": {
				const text = str(args.content, 300);
				const origin = str(args.origin, 80);
				if (!text || !origin) return err("content e origin obrigatórios");
				const category = str(args.category, 40)?.toLowerCase();
				if (category === PENDING_CATEGORY || category === PENDING_RESOLVED_CATEGORY) return err("use save_pending para pendências");
				const content = text.toLowerCase().includes(origin.toLowerCase()) ? text : `${text} (origem: ${origin})`;
				// Destino fixo: a memória do orquestrador. Nenhum argumento escolhe outro bot.
				const added = await ports.addMemory({ userId, botId: ctx.primaryBotId, content, category: category ?? "contexto", importance: num01(args.importance) ?? 0.5, source: `reflexao: ${origin}` });
				if (added.skipped) return good({ skipped: added.skipped });
				if (!added.ok) return added.error === "duplicado" ? good({ skipped: "duplicado" }) : { ok: false, result: added };
				ctx.changes.push({ op: "save", botId: ctx.primaryBotId, id: added.entry?.id ?? "", content, origin });
				return good();
			}
			case "merge_memories": {
				const refs = Array.isArray(args.refs) ? [...new Set(args.refs.map((r) => String(r).trim().toUpperCase()))] : [];
				const content = str(args.content, 600);
				if (refs.length < 2 || !content) return err("refs (2 ou mais) e content obrigatórios");
				const resolved = refs.map((ref) => memoryRef(ctx, ref));
				if (resolved.some((r) => !r)) return err("ref desconhecida");
				const items = resolved as Array<Extract<ReflectionRef, { kind: "memory" }>>;
				const first = items[0]!;
				if (items.some((r) => r.botId !== first.botId || r.target !== first.target)) return err("só junte memórias do mesmo bot e da mesma camada");
				if (refs.some((ref) => ctx.pending.has(ref))) return err("pendências não se unem aqui");
				const rows = await Promise.all(items.map((r) => ports.getOwnedMemory(userId, r.id)));
				if (rows.some((row) => !row)) return err("entrada não encontrada");
				const before = rows.map((row) => row!.content);
				if (!(await ports.updateOwnedMemory(userId, first.id, { content }))) return err("entrada não encontrada");
				for (const extra of items.slice(1)) await ports.deleteOwnedMemory(userId, extra.id);
				ctx.changes.push({ op: "merge", botId: first.botId, target: first.target, keptId: first.id, removedIds: items.slice(1).map((r) => r.id), before, after: content });
				return good();
			}
			case "remove_memory": {
				const ref = typeof args.ref === "string" ? args.ref.trim().toUpperCase() : "";
				const target = memoryRef(ctx, ref);
				if (!target) return err("ref desconhecida");
				if (ctx.pending.has(ref)) return err("use resolve_pending");
				const row = await ports.getOwnedMemory(userId, target.id);
				if (!row) return err("entrada não encontrada");
				await ports.deleteOwnedMemory(userId, target.id);
				ctx.changes.push({ op: "remove", botId: target.botId, target: target.target, id: target.id, before: row.content, reason: str(args.reason, 160) ?? "" });
				return good();
			}
			case "suggest_bot_profile": {
				if (!ctx.conversationId) return err("sem conversa do orquestrador");
				if (ctx.cardsUsed >= REFLECTION_MAX_CARDS) return err("limite de sugestões atingido");
				const botRef = typeof args.bot_ref === "string" ? ctx.refs.get(args.bot_ref.trim().toUpperCase()) : undefined;
				if (botRef?.kind !== "bot") return err("bot_ref desconhecido");
				const after: { name?: string; snippet?: string; description?: string | null } = {};
				const name = str(args.name, 80);
				const snippet = str(args.snippet, 140);
				const description = typeof args.description === "string" ? args.description.trim().slice(0, 2000) : undefined;
				if (name) after.name = name;
				if (snippet) after.snippet = snippet;
				if (description) after.description = description;
				const proposalId = `reflection-${ctx.rowId}-${ctx.cardsUsed + 1}`;
				const card = await ports.appendCard({ userId, conversationId: ctx.conversationId, proposalId, botId: botRef.id, after });
				if (!card.ok) return err(card.reason);
				ctx.cardsUsed += 1;
				ctx.changes.push({ op: "profile-card", botId: botRef.id, proposalId, fields: card.fields, reason: str(args.reason, 200) ?? "" });
				return good();
			}
			case "finish": {
				ctx.finished = { summary: typeof args.summary === "string" ? args.summary.trim().slice(0, 1200) : "", important: args.important === true };
				return good();
			}
			default:
				return err(`ferramenta desconhecida: ${name}`);
		}
	} catch (error) {
		return err(error instanceof Error ? error.message : "erro ao executar");
	}
}

/**
 * Chamada sem streaming com contexto de até ~28k caracteres: os padrões (30s até a resposta, 90s no
 * total) são curtos demais para um modelo de raciocínio devolvendo várias chamadas de ferramenta.
 */
export const REFLECTION_CALL_LIMITS = { timeoutMs: 180_000, firstEventTimeoutMs: 150_000, idleTimeoutMs: 60_000, maxOutputTokens: 4_000 } as const;

export type ReflectionUsage = { model: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number };

/** Fase A: laço curto de ferramentas. Para ao `finish`, sem chamadas de ferramenta, no teto de passos ou de tokens. */
export async function runReflectionLoop(
	input: { text: string; language: BotLanguage; model: string; apiKey: string },
	ctx: ReflectionContext,
	complete: typeof completeChatWithTools = completeChatWithTools,
): Promise<ReflectionUsage> {
	const usage: ReflectionUsage = { model: input.model, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	const conversation: LlmMessage[] = [
		{ role: "system", content: `${REFLECTION_SYSTEM_PROMPT}\n\n${languageInstruction(input.language)}` },
		{ role: "user", content: input.text },
	];
	for (let step = 0; step < REFLECTION_MAX_STEPS && !ctx.finished && usage.totalTokens < REFLECTION_MAX_TOKENS; step += 1) {
		const result = await complete({ messages: conversation, model: input.model, apiKey: input.apiKey, tools: REFLECTION_TOOLS, ...REFLECTION_CALL_LIMITS });
		usage.calls += 1;
		usage.model = result.model ?? usage.model;
		usage.promptTokens += result.usage?.promptTokens ?? 0;
		usage.completionTokens += result.usage?.completionTokens ?? 0;
		usage.totalTokens += result.usage?.totalTokens ?? (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0);
		if (result.usage?.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + result.usage.costUsd;
		const toolCalls = result.message.tool_calls ?? [];
		if (toolCalls.length === 0) break;
		conversation.push({ role: "assistant", content: result.message.content, tool_calls: toolCalls });
		for (const call of toolCalls) {
			const outcome = await executeReflectionTool(call.function.name, call.function.arguments, ctx);
			conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.result) });
		}
	}
	return usage;
}

export type RecheckReport = Array<{ status: "resolved" | "problem" | "unknown"; text: string; finding: string }>;

/** Fase B: reverifica até 3 pendências (as mais importantes/antigas) só com leitura e aplica o resultado. */
export async function recheckPendings(ctx: ReflectionContext): Promise<{ report: RecheckReport; ran: boolean }> {
	const entries = [...ctx.pending.values()];
	const picked = pickPendingsToRecheck(entries);
	if (picked.length === 0) return { report: [], ran: false };
	const items = picked.map((entry, index) => ({ ref: `P${index + 1}`, text: entry.content, entry }));
	const objective = buildRecheckObjective(items.map(({ ref, text }) => ({ ref, text })), ctx.timeZone, ctx.now);
	const outcome = await ctx.ports.runRecheck({ userId: ctx.userId, botId: ctx.primaryBotId, objective }).catch(() => null);
	if (!outcome || outcome.status !== "completed") return { report: [], ran: true };
	const results = parseRecheckResult(outcome.text, items.map((item) => item.ref));
	const report: RecheckReport = [];
	for (const result of results) {
		const item = items.find((candidate) => candidate.ref === result.ref)!;
		if (result.status === "resolved") {
			const after = markPendingResolved(item.entry.content, ctx.now, ctx.timeZone, result.finding);
			const validUntil = new Date(ctx.now.getTime() + 14 * 86_400_000);
			if (!(await ctx.ports.updateOwnedMemory(ctx.userId, item.entry.id, { content: after, category: PENDING_RESOLVED_CATEGORY, importance: 0.2, validUntil }))) continue;
			for (const [key, value] of ctx.pending) if (value.id === item.entry.id) ctx.pending.delete(key);
			ctx.changes.push({ op: "pending-resolve", botId: ctx.primaryBotId, id: item.entry.id, before: item.entry.content, after, how: "verificacao" });
		} else {
			const after = notePendingChecked(item.entry.content, ctx.now, ctx.timeZone, result.status, result.finding);
			if (!(await ctx.ports.updateOwnedMemory(ctx.userId, item.entry.id, { content: after }))) continue;
			ctx.changes.push({ op: "pending-checked", botId: ctx.primaryBotId, id: item.entry.id, before: item.entry.content, after, status: result.status });
		}
		report.push({ status: result.status, text: item.entry.content, finding: result.finding });
	}
	return { report, ran: true };
}

export type ReflectionRunDeps = {
	ports: ReflectionPorts;
	complete?: typeof completeChatWithTools;
	model: string;
	apiKey: string;
	language: BotLanguage;
	/** Escrita no banco e envio: injetados para teste. */
	finish: (patch: { status: "done" | "skipped" | "failed"; summary?: string; important?: boolean; changes?: ReflectionChange[]; stats?: Record<string, unknown>; detail?: string }) => Promise<void>;
	postMessage: (conversationId: string, text: string) => Promise<void>;
	notify?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
	hasActivity: boolean;
	/** Manual ignora o "sem atividade nova". */
	force: boolean;
	log?: (line: string) => void;
};

export type ReflectionRunInput = {
	userId: string;
	rowId: string;
	primary: { id: string; name: string; conversationId: string | null };
	input: ReflectionInput;
	now: Date;
};

export type ReflectionRunResult = { status: "done" | "skipped" | "failed"; posted: boolean; notified: boolean; changes: ReflectionChange[]; detail?: string };

export async function runReflection(run: ReflectionRunInput, deps: ReflectionRunDeps): Promise<ReflectionRunResult> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const { input } = run;
	const orchestrator = input.bots.find((bot) => bot.id === run.primary.id);
	const { text, refs } = buildReflectionContext(input);
	const pending = new Map<string, PendingEntry>();
	for (const [ref, value] of refs) {
		if (value.kind !== "memory" || value.botId !== run.primary.id) continue;
		const memory = orchestrator?.memories.find((m) => m.id === value.id);
		if (memory && isOpenPending({ content: memory.content, category: memory.category })) {
			pending.set(ref, { id: memory.id, content: memory.content, category: memory.category, importance: memory.importance, createdAt: memory.createdAt, updatedAt: memory.updatedAt });
		}
	}
	const ctx: ReflectionContext = {
		userId: run.userId,
		primaryBotId: run.primary.id,
		primaryBotName: run.primary.name,
		conversationId: run.primary.conversationId,
		rowId: run.rowId,
		now: run.now,
		timeZone: input.timeZone,
		refs,
		botNames: new Map(input.bots.map((bot) => [bot.id, bot.name])),
		pending,
		changes: [],
		cardsUsed: 0,
		finished: null,
		ports: deps.ports,
	};

	if (!deps.hasActivity && !deps.force && pending.size === 0) {
		await deps.finish({ status: "skipped", detail: "sem atividade nova" });
		log(`[reflection] user=${run.userId} skipped reason=no_activity`);
		return { status: "skipped", posted: false, notified: false, changes: [], detail: "sem atividade nova" };
	}

	let stage: ReflectionFailureStage = "model";
	let usage: ReflectionUsage | null = null;
	try {
		// Sem atividade nova só verifica pendências (sem chamar o modelo de manutenção).
		stage = "model";
		if (deps.hasActivity || deps.force) usage = await runReflectionLoop({ text, language: deps.language, model: deps.model, apiKey: deps.apiKey }, ctx, deps.complete);
		stage = "apply";
		const { report, ran } = await recheckPendings(ctx);
		stage = "post";

		const summary = ctx.finished?.summary ?? (usage ? "" : "");
		const problems = report.filter((item) => item.status === "problem").length;
		const resolved = report.filter((item) => item.status === "resolved").length;
		// Sem resumo do modelo mas com achado da verificação: o achado é a mensagem.
		const baseSummary = summary || (problems + resolved > 0 ? (problems > 0 ? "Reverifiquei suas pendências e encontrei algo." : "Reverifiquei suas pendências.") : "");
		const outcome = decideReflectionOutcome({ summary: baseSummary, important: ctx.finished?.important ?? false, changes: ctx.changes, problems });
		const message = outcome.post ? formatReflectionMessage(baseSummary, ctx.changes, report) : "";

		let posted = false;
		let notified = false;
		if (outcome.post && ctx.conversationId) {
			await deps.postMessage(ctx.conversationId, message);
			posted = true;
			if (outcome.notify && deps.notify) {
				await deps.notify(run.userId, ctx.conversationId, message).catch(() => undefined);
				notified = true;
			}
		}
		stage = "save";
		await deps.finish({
			status: "done",
			summary: outcome.post ? message : baseSummary,
			important: outcome.notify,
			changes: ctx.changes,
			stats: {
				model: usage?.model ?? deps.model,
				calls: usage?.calls ?? 0,
				tokens: usage?.totalTokens ?? 0,
				...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
				bots: input.bots.length,
				recheck: ran,
				problems,
				resolved,
				posted,
				notified,
			},
		});
		log(`[reflection] user=${run.userId} done changes=${ctx.changes.length} posted=${posted} notified=${notified} recheck=${ran}`);
		return { status: "done", posted, notified, changes: ctx.changes };
	} catch (error) {
		const failure = toReflectionFailure(error, stage);
		log(reflectionFailureLogLine(run.userId, failure));
		await deps.finish({
			status: "failed",
			detail: failure.label,
			changes: ctx.changes,
			stats: { code: failure.code, stage: failure.stage, error: failure.message, model: usage?.model ?? deps.model, calls: usage?.calls ?? 0 },
		});
		return { status: "failed", posted: false, notified: false, changes: ctx.changes, detail: failure.label };
	}
}
