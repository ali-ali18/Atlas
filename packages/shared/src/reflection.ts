/**
 * Reflexão diária do orquestrador (bot principal): quando roda, o que ele lê, o que decide
 * sozinho e quando avisa. Funções puras (sem I/O): relógio por `now`, fuso por `timeZone`.
 * Só o orquestrador recebe o conhecimento cruzado; os outros bots seguem isolados.
 */
import { DEFAULT_PROACTIVE_TIMEZONE, isValidTimeZone, localParts, normalizeForDedupe, parseClockMinutes, wordOverlap } from "./proactive.js";
import { zonedWallTimeToUtc } from "./routine-once.js";

export const REFLECTION_DEFAULT_TIME = "06:00";
/** Teto de passos do modelo e de tokens por reflexão (custo). */
export const REFLECTION_MAX_STEPS = 8;
export const REFLECTION_MAX_TOKENS = 80_000;
/** Cartões de sugestão por reflexão. */
export const REFLECTION_MAX_CARDS = 3;
/** Pendências reverificadas por reflexão e passos do run de verificação. */
export const REFLECTION_MAX_RECHECKS = 3;
export const REFLECTION_RECHECK_MAX_STEPS = 14;
/** Orçamento de texto do contexto (caracteres) e por bot. */
export const REFLECTION_CONTEXT_CHARS = 28_000;
export const REFLECTION_BOT_ACTIVITY_CHARS = 2_400;
export const REFLECTION_MEMORY_PER_BOT = 40;
export const REFLECTION_MEMORY_ENTRY_CHARS = 240;
/** Categoria das pendências na memória do orquestrador. */
export const PENDING_CATEGORY = "pendencia";
export const PENDING_RESOLVED_CATEGORY = "pendencia-resolvida";
/** Marca no objetivo do run de verificação (origem `proactive`, que a API não aceita de clientes). */
export const REFLECTION_RECHECK_PREFIX = "[verificacao-de-pendencias]";

export type ReflectionSettings = { enabled: boolean; time: string };

/** Lê `config.reflection` (desligada por padrão; horário inválido volta ao padrão). */
export function readReflectionSettings(config: { reflection?: { enabled?: unknown; time?: unknown } } | null | undefined): ReflectionSettings {
	const raw = config?.reflection;
	const time = typeof raw?.time === "string" && parseClockMinutes(raw.time) !== null ? normalizeClock(raw.time) : REFLECTION_DEFAULT_TIME;
	return { enabled: raw?.enabled === true, time };
}

function normalizeClock(value: string): string {
	const minutes = parseClockMinutes(value) ?? 0;
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Fuso da reflexão: o da conta (Configurações → Geral) ou o padrão. */
export function reflectionTimeZone(accountTimezone: string | null | undefined): string {
	return isValidTimeZone(accountTimezone) ? accountTimezone : DEFAULT_PROACTIVE_TIMEZONE;
}

/** Instante do horário escolhido no dia local de `now`. */
export function reflectionSlotAt(now: Date, timeZone: string, time: string): Date {
	const parts = localParts(now, timeZone);
	const minutes = parseClockMinutes(time) ?? parseClockMinutes(REFLECTION_DEFAULT_TIME)!;
	return zonedWallTimeToUtc(
		{ year: parts.year, month: parts.month, day: parts.day, hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0 },
		timeZone,
	);
}

/**
 * A reflexão agendada já deve rodar? Ligada, passou do horário de hoje (no fuso da conta)
 * e ainda não houve tentativa desde esse horário. Uma tentativa por dia, mesmo se falhar.
 */
export function isReflectionScheduleDue(input: {
	settings: ReflectionSettings;
	timeZone: string;
	now: Date;
	lastAttemptAt: Date | null;
}): boolean {
	if (!input.settings.enabled) return false;
	const slot = reflectionSlotAt(input.now, input.timeZone, input.settings.time);
	if (input.now.getTime() < slot.getTime()) return false;
	return !input.lastAttemptAt || input.lastAttemptAt.getTime() < slot.getTime();
}

// ---------------------------------------------------------------------------
// Eventos (webhook, rotinas, erros de run)
// ---------------------------------------------------------------------------

export type ReflectionEventKind = "webhook" | "github" | "routine" | "reminder" | "run-failed";

export type ReflectionEvent = {
	botId: string;
	botName: string;
	kind: ReflectionEventKind;
	/** "webhook.received", nome da rotina, objetivo do run... */
	label: string;
	/** Texto curto do evento ou do erro. */
	detail?: string;
	/** Rotina/lembrete que correu bem: ruído, vira só contagem. */
	ok?: boolean;
	at: Date;
};

export type ReflectionEventGroup = {
	botId: string;
	botName: string;
	kind: ReflectionEventKind;
	label: string;
	detail: string;
	count: number;
	firstAt: Date;
	lastAt: Date;
};

const volatile = (text: string): string =>
	normalizeForDedupe(text)
		.replace(/\b[0-9a-f]{8,}\b/g, "")
		.replace(/\b\d+\b/g, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Junta eventos repetidos (mesmo bot, tipo, rótulo e texto sem números/ids) em um grupo com
 * contagem. Rotinas e lembretes que deram certo não são fatos: só entram na contagem `noise`.
 */
export function groupReflectionEvents(events: readonly ReflectionEvent[], maxGroups = 30): { groups: ReflectionEventGroup[]; noise: number } {
	const map = new Map<string, ReflectionEventGroup>();
	let noise = 0;
	for (const event of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
		if ((event.kind === "routine" || event.kind === "reminder") && event.ok !== false) {
			noise += 1;
			continue;
		}
		const detail = (event.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
		const key = [event.botId, event.kind, volatile(event.label), volatile(detail)].join("|");
		const current = map.get(key);
		if (current) {
			current.count += 1;
			current.lastAt = event.at;
			continue;
		}
		map.set(key, { botId: event.botId, botName: event.botName, kind: event.kind, label: event.label.slice(0, 120), detail, count: 1, firstAt: event.at, lastAt: event.at });
	}
	const groups = [...map.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime()).slice(0, maxGroups);
	return { groups, noise };
}

const KIND_TITLE: Record<ReflectionEventKind, string> = {
	webhook: "Webhook",
	github: "GitHub",
	routine: "Rotina falhou",
	reminder: "Lembrete falhou",
	"run-failed": "Run com erro",
};

function stamp(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function dayStamp(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(date);
}

export function formatEventGroup(group: ReflectionEventGroup, timeZone: string): string {
	const times = group.count > 1 ? `${group.count}x, de ${stamp(group.firstAt, timeZone)} a ${stamp(group.lastAt, timeZone)}` : stamp(group.lastAt, timeZone);
	return `- [${group.botName}] ${KIND_TITLE[group.kind]}: ${group.label}${group.detail ? ` — ${group.detail}` : ""} (${times})`;
}

// ---------------------------------------------------------------------------
// Pendências em aberto
// ---------------------------------------------------------------------------

export type PendingEntry = { id: string; content: string; category: string | null; importance: number | null; createdAt: Date; updatedAt: Date };

const OPEN_MARK = "[ABERTA";

/** Pendência ainda aberta: categoria `pendencia` e conteúdo começando por `[ABERTA`. */
export function isOpenPending(entry: Pick<PendingEntry, "content" | "category">): boolean {
	return entry.category === PENDING_CATEGORY && entry.content.trimStart().startsWith(OPEN_MARK);
}

export function formatOpenPending(text: string, origin: string, at: Date, timeZone: string): string {
	const body = text.replace(/\s+/g, " ").trim().replace(/^\[(ABERTA|RESOLVIDA)[^\]]*\]\s*/i, "");
	return `[ABERTA] ${body} (origem: ${origin}, ${dayStamp(at, timeZone)})`.slice(0, 400);
}

export function markPendingResolved(content: string, at: Date, timeZone: string, finding?: string): string {
	const body = content.replace(/^\s*\[ABERTA[^\]]*\]\s*/i, "");
	return `[RESOLVIDA ${dayStamp(at, timeZone)}] ${body}${finding ? ` — ${finding.replace(/\s+/g, " ").trim().slice(0, 160)}` : ""}`.slice(0, 500);
}

export function notePendingChecked(content: string, at: Date, timeZone: string, status: "problem" | "unknown", finding: string): string {
	const base = content.replace(/\s*\(verificada \d{2}\/\d{2}:[^)]*\)\s*$/i, "");
	const label = status === "problem" ? "problema" : "sem conclusão";
	return `${base} (verificada ${dayStamp(at, timeZone)}: ${label}${finding ? ` — ${finding.replace(/\s+/g, " ").trim().slice(0, 140)}` : ""})`.slice(0, 600);
}

/** A pendência proposta repete uma aberta (sobreposição alta de palavras)? */
export function findDuplicatePending<T extends Pick<PendingEntry, "content" | "category">>(open: readonly T[], text: string): T | undefined {
	return open.find((entry) => isOpenPending(entry) && wordOverlap(entry.content, text) >= 0.7);
}

/**
 * Quais pendências reverificar hoje: só abertas, no máximo `max`, as mais importantes primeiro e,
 * entre iguais, as que não foram tocadas há mais tempo (rodízio). Resolvidas nunca entram.
 */
export function pickPendingsToRecheck<T extends PendingEntry>(entries: readonly T[], max = REFLECTION_MAX_RECHECKS): T[] {
	return entries
		.filter(isOpenPending)
		.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || a.updatedAt.getTime() - b.updatedAt.getTime())
		.slice(0, Math.max(0, max));
}

// ---------------------------------------------------------------------------
// Verificação somente leitura
// ---------------------------------------------------------------------------

/** Ferramentas nativas que só consultam (busca/leitura, notas internas do run e descoberta de conectores). */
export const RECHECK_NATIVE_READ_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_extract", "mcp_tool_search", "read_cached_result", "research_note"]);

/**
 * Filtro de ferramentas do run de verificação: só leitura nativa ou ferramenta de conector que o
 * servidor declara somente leitura. Sem declaração (undefined) não há garantia: fica de fora.
 */
export function isRecheckToolAllowed(name: string, mcpReadOnly: boolean | undefined): boolean {
	if (RECHECK_NATIVE_READ_TOOLS.has(name)) return true;
	return mcpReadOnly === true;
}

export function isRecheckObjective(origin: string | null | undefined, objective: string | null | undefined): boolean {
	return origin === "proactive" && typeof objective === "string" && objective.startsWith(REFLECTION_RECHECK_PREFIX);
}

export type RecheckItem = { ref: string; text: string };

export function buildRecheckObjective(items: readonly RecheckItem[], timeZone: string, now: Date): string {
	const lines = items.map((item) => `${item.ref}: ${item.text}`);
	return [
		`${REFLECTION_RECHECK_PREFIX} Verificação diária de pendências (${stamp(now, timeZone)})`,
		"",
		"Para cada pendência abaixo, descubra se o problema continua, já foi resolvido ou não dá para saber.",
		"Use SOMENTE ferramentas que consultam (listar, ler, buscar, status). Você não tem acesso a nada que altere, envie, crie ou apague, e não deve tentar contornar isso.",
		"Se não houver ferramenta de leitura adequada, responda `unknown` sem inventar. Seja breve: no máximo " + REFLECTION_RECHECK_MAX_STEPS + " passos no total.",
		"",
		...lines,
		"",
		"Termine com UM objeto JSON e nada depois:",
		'{"results":[{"ref":"P1","status":"resolved|problem|unknown","finding":"uma frase com o que viu"}]}',
	].join("\n");
}

export type RecheckResult = { ref: string; status: "resolved" | "problem" | "unknown"; finding: string };

/** Lê o JSON final do run de verificação; ignora refs desconhecidas e status inválidos. */
export function parseRecheckResult(text: string | null | undefined, validRefs: readonly string[]): RecheckResult[] {
	if (!text) return [];
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	const results = (parsed as { results?: unknown })?.results;
	if (!Array.isArray(results)) return [];
	const seen = new Set<string>();
	const out: RecheckResult[] = [];
	for (const item of results) {
		if (!item || typeof item !== "object") continue;
		const { ref, status, finding } = item as Record<string, unknown>;
		if (typeof ref !== "string" || !validRefs.includes(ref) || seen.has(ref)) continue;
		if (status !== "resolved" && status !== "problem" && status !== "unknown") continue;
		seen.add(ref);
		out.push({ ref, status, finding: typeof finding === "string" ? finding.replace(/\s+/g, " ").trim().slice(0, 300) : "" });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Contexto para o modelo
// ---------------------------------------------------------------------------

export type ReflectionMemory = {
	id: string;
	target: "user" | "memory";
	content: string;
	category: string | null;
	importance: number | null;
	validUntil: Date | null;
	source: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type ReflectionBotInput = {
	id: string;
	name: string;
	snippet: string;
	description: string | null;
	isOrchestrator: boolean;
	memories: ReflectionMemory[];
	/** Último resumo da conversa do bot, de qualquer época (já existente). */
	summary: string | null;
	/** Mensagens novas desde a última reflexão (já curtas). */
	recent: Array<{ role: "user" | "assistant"; text: string; at: Date }>;
	newMessages: number;
	events: ReflectionEvent[];
	/** Falas do bot que o usuário marcou com 👎 desde a última reflexão (nota leve, só leitura). */
	dislikedReplies?: Array<{ text: string; at: Date }>;
};

export type ReflectionInput = {
	now: Date;
	timeZone: string;
	since: Date | null;
	/** Memórias do perfil `user` (compartilhadas entre os bots). */
	userMemories: ReflectionMemory[];
	bots: ReflectionBotInput[];
};

export type ReflectionRef =
	| { kind: "memory"; id: string; botId: string | null; target: "user" | "memory" }
	| { kind: "bot"; id: string };

const clip = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

function memoryLine(ref: string, memory: ReflectionMemory, timeZone: string): string {
	const meta = [
		memory.category,
		memory.importance ? `imp ${memory.importance.toFixed(1)}` : null,
		memory.validUntil ? `vence ${stamp(memory.validUntil, timeZone)}` : null,
		memory.source ? `origem: ${memory.source}` : null,
		`atual. ${stamp(memory.updatedAt, timeZone)}`,
	]
		.filter(Boolean)
		.join(", ");
	return `${ref} (${meta}): ${clip(memory.content, REFLECTION_MEMORY_ENTRY_CHARS)}`;
}

/**
 * Monta o contexto da reflexão com referências curtas (B1, M3…) em vez de ids: o modelo só
 * consegue agir sobre o que listamos, e cada referência já carrega dono e camada.
 */
export function buildReflectionContext(input: ReflectionInput): { text: string; refs: Map<string, ReflectionRef> } {
	const refs = new Map<string, ReflectionRef>();
	const lines: string[] = [];
	lines.push(`Agora: ${stamp(input.now, input.timeZone)} (${input.timeZone}). Última reflexão: ${input.since ? stamp(input.since, input.timeZone) : "nunca"}.`);
	let counter = 0;
	const addMemory = (memory: ReflectionMemory, botId: string | null): string => {
		counter += 1;
		const ref = `M${counter}`;
		refs.set(ref, { kind: "memory", id: memory.id, botId, target: memory.target });
		return memoryLine(ref, memory, input.timeZone);
	};

	lines.push("", "== PERFIL DO USUÁRIO (memória `user`, compartilhada por todos os bots) ==");
	if (input.userMemories.length === 0) lines.push("(vazio)");
	for (const memory of input.userMemories.slice(0, REFLECTION_MEMORY_PER_BOT)) lines.push(addMemory(memory, null));

	input.bots.forEach((bot, index) => {
		const ref = `B${index + 1}`;
		refs.set(ref, { kind: "bot", id: bot.id });
		lines.push("", `== ${ref} ${bot.name}${bot.isOrchestrator ? " (VOCÊ, o orquestrador)" : ""} ==`);
		lines.push(`Perfil: ${clip(bot.snippet, 140)}${bot.description ? ` | ${clip(bot.description, 400)}` : ""}`);
		lines.push("Memórias do bot:");
		const memories = bot.isOrchestrator ? bot.memories.filter((m) => !isOpenPending({ content: m.content, category: m.category })) : bot.memories;
		if (memories.length === 0) lines.push("(vazio)");
		for (const memory of memories.slice(0, REFLECTION_MEMORY_PER_BOT)) lines.push(addMemory(memory, bot.id));
		if (bot.isOrchestrator) {
			const open = bot.memories.filter((m) => isOpenPending({ content: m.content, category: m.category }));
			lines.push("Pendências em aberto que você já acompanha:");
			if (open.length === 0) lines.push("(nenhuma)");
			for (const memory of open) lines.push(addMemory(memory, bot.id));
		}
		const activity: string[] = [];
		if (bot.summary) activity.push(`Resumo da conversa (qualquer época): ${clip(bot.summary, 700)}`);
		if (bot.newMessages > 0) {
			activity.push(`Mensagens novas: ${bot.newMessages}. Últimas:`);
			for (const message of bot.recent) activity.push(`  ${message.role === "user" ? "Usuário" : "Bot"}: ${clip(message.text, 240)}`);
		}
		for (const reply of (bot.dislikedReplies ?? []).slice(0, 5)) activity.push(`O usuário marcou 👎 numa resposta (${stamp(reply.at, input.timeZone)}): ${clip(reply.text, 200)}`);
		const { groups, noise } = groupReflectionEvents(bot.events, 12);
		for (const group of groups) activity.push(formatEventGroup(group, input.timeZone));
		if (noise > 0) activity.push(`(${noise} execuções de rotina/lembrete sem problema: ignore)`);
		if (activity.length === 0) activity.push("Sem atividade nova.");
		let block = activity.join("\n");
		if (block.length > REFLECTION_BOT_ACTIVITY_CHARS) block = `${block.slice(0, REFLECTION_BOT_ACTIVITY_CHARS - 1)}…`;
		lines.push("Atividade:", block);
	});

	let text = lines.join("\n");
	if (text.length > REFLECTION_CONTEXT_CHARS) text = `${text.slice(0, REFLECTION_CONTEXT_CHARS - 1)}…`;
	return { text, refs };
}

export const REFLECTION_SYSTEM_PROMPT = [
	"Você é o orquestrador: o bot principal do usuário. Uma vez por dia faz uma reflexão silenciosa sobre a memória e as conversas de TODOS os bots dele.",
	"Você recebe as memórias de cada bot (referências M1, M2…), o perfil de cada bot (B1, B2…), o último resumo de cada conversa (de qualquer época) e o que aconteceu desde a última reflexão.",
	"",
	"PRIORIDADE 1, pendências em aberto: procure nas memórias e nos resumos de TODAS as conversas, inclusive antigas, problemas ou pedidos do usuário que ficaram sem desfecho (ex.: \"pediu ajuda com o sync do Bling no n8n; não confirmado resolvido\").",
	"- `save_pending`: registre cada pendência real e ainda sem desfecho na SUA memória, em uma frase, com o bot de origem. Não registre o que já está em \"Pendências em aberto\" nem coisas triviais.",
	"- `resolve_pending`: se as memórias ou conversas mostram que uma pendência já acompanhada foi resolvida, marque como resolvida (ref M#).",
	"",
	"PRIORIDADE 2, fatos e limpeza:",
	"- `save_fact`: grave na SUA memória (só nela) fatos úteis vindos dos outros bots ou de eventos (webhooks, rotinas com falha, runs com erro): problemas ativos, decisões, mudanças de ambiente. Cite a origem e a data. Ex.: \"Servidor reiniciado em 15/10 08:43 (visto no webhook do Dokploy)\".",
	"- `merge_memories`: junte duplicadas ou quase iguais DO MESMO bot (ou do perfil `user`) em uma só, mais completa e curta.",
	"- `remove_memory`: apague o que venceu, ficou obsoleto ou é contradito por algo mais novo (mantenha a mais recente e correta). Na dúvida, NÃO apague.",
	"- `suggest_bot_profile`: se um bot teria desempenho melhor com outro perfil (nome, resumo, descrição/instruções, tom), proponha. O usuário aprova num cartão; nada é aplicado sem ele. No máximo " + REFLECTION_MAX_CARDS + " por vez, só com ganho claro.",
	"",
	"`finish` encerra SEMPRE: resumo curto (2 a 5 linhas, pt-BR, sem emojis, tom natural) do que achou de importante e do que limpou. `important` = true SÓ se houver problema, pendência ou alerta que o usuário precise ver agora.",
	"",
	"Regras:",
	"- Eventos repetidos (mesmo webhook várias vezes) viram UM fato com a contagem e o período. Execuções normais de rotina e ruído não viram memória.",
	"- Webhooks, rotinas e erros são fonte secundária de fatos: só guarde o que ajuda a orientar o usuário.",
	"- Não guarde segredos, tokens ou senhas, nem trechos longos de conversa. Uma frase densa por fato.",
	"- Nunca peça nada ao usuário aqui: isto não é uma conversa. Sem nada relevante, chame `finish` com summary vazio.",
	"- Mudanças de perfil NUNCA são aplicadas por você; só proponha.",
].join("\n");

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export type ReflectionChange =
	| { op: "merge"; botId: string | null; target: "user" | "memory"; keptId: string; removedIds: string[]; before: string[]; after: string }
	| { op: "remove"; botId: string | null; target: "user" | "memory"; id: string; before: string; reason: string }
	| { op: "save"; botId: string; id: string; content: string; origin: string }
	| { op: "pending-save"; botId: string; id: string; content: string; origin: string }
	| { op: "pending-resolve"; botId: string; id: string; before: string; after: string; how: "conversa" | "verificacao" }
	| { op: "pending-checked"; botId: string; id: string; before: string; after: string; status: "problem" | "unknown" }
	| { op: "profile-card"; botId: string; proposalId: string; fields: string[]; reason: string };

export type ReflectionOutcome = {
	/** Escreve a mensagem curta na conversa do orquestrador? */
	post: boolean;
	/** Dispara o push? Só para problema/pendência/alerta. */
	notify: boolean;
};

/**
 * Mensagem só se há resumo E algo a mostrar (achado importante, limpeza, fato salvo, pendência ou
 * cartão). Push só se for importante (ou se a verificação achou problema) e há texto para o corpo.
 */
export function decideReflectionOutcome(input: {
	summary: string;
	important: boolean;
	changes: readonly ReflectionChange[];
	problems?: number;
}): ReflectionOutcome {
	const summary = input.summary.trim();
	if (!summary) return { post: false, notify: false };
	const important = input.important || (input.problems ?? 0) > 0;
	const post = important || input.changes.length > 0;
	return { post, notify: post && important };
}

/** Texto da mensagem na conversa do orquestrador: resumo + verificação + contagem da limpeza. */
export function formatReflectionMessage(summary: string, changes: readonly ReflectionChange[], rechecks: ReadonlyArray<{ status: "resolved" | "problem" | "unknown"; text: string; finding: string }> = []): string {
	const count = (op: ReflectionChange["op"]) => changes.filter((c) => c.op === op).length;
	const merged = count("merge");
	const removed = count("remove");
	const saved = count("save") + count("pending-save");
	const cards = count("profile-card");
	const parts = [
		merged ? `${merged} ${merged === 1 ? "memória unida" : "memórias unidas"}` : null,
		removed ? `${removed} ${removed === 1 ? "removida" : "removidas"}` : null,
		saved ? `${saved} ${saved === 1 ? "item salvo" : "itens salvos"} na minha memória` : null,
		cards ? `${cards} ${cards === 1 ? "sugestão aguardando você" : "sugestões aguardando você"}` : null,
	].filter(Boolean);
	const lines: string[] = [summary.trim()];
	const shown = rechecks.filter((item) => item.status !== "unknown");
	if (shown.length > 0) {
		lines.push("", "Pendências que reverifiquei:");
		for (const item of shown) {
			lines.push(`- ${item.status === "resolved" ? "Resolvida" : "Ainda com problema"}: ${clip(item.text.replace(/^\[ABERTA[^\]]*\]\s*/i, ""), 140)}${item.finding ? ` — ${clip(item.finding, 160)}` : ""}`);
		}
	}
	if (parts.length > 0) lines.push("", `Limpeza: ${parts.join(", ")}.`);
	return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Falhas: motivo curto para a UI e texto técnico (sem segredos) para o log
// ---------------------------------------------------------------------------

export type ReflectionFailureStage = "setup" | "context" | "model" | "apply" | "post" | "save";

export type ReflectionFailureCode =
	| "no_api_key"
	| "model_auth"
	| "model_credits"
	| "model_unavailable"
	| "model_no_tools"
	| "model_rate_limited"
	| "model_timeout"
	| "model_down"
	| "model_error"
	| "db_error"
	| "no_conversation"
	| "post_failed"
	| "interrupted"
	| "unknown";

/** Rótulos curtos (cabem na linha de estado): "falhou · <rótulo>". */
export const REFLECTION_FAILURE_LABELS: Record<ReflectionFailureCode, string> = {
	no_api_key: "sem chave OpenRouter no servidor",
	model_auth: "chave OpenRouter recusada",
	model_credits: "sem créditos no OpenRouter",
	model_unavailable: "modelo de manutenção indisponível",
	model_no_tools: "modelo de manutenção sem suporte a ferramentas",
	model_rate_limited: "limite do OpenRouter, tente de novo",
	model_timeout: "modelo de manutenção demorou demais",
	model_down: "OpenRouter fora do ar",
	model_error: "erro no modelo de manutenção",
	db_error: "erro ao ler o banco",
	no_conversation: "sem conversa do bot principal",
	post_failed: "erro ao enviar a mensagem",
	interrupted: "interrompida (servidor reiniciou)",
	unknown: "erro inesperado",
};

export class ReflectionFailure extends Error {
	readonly code: ReflectionFailureCode;
	readonly stage: ReflectionFailureStage;
	constructor(code: ReflectionFailureCode, stage: ReflectionFailureStage, technical: string, options?: { cause?: unknown }) {
		super(technical, options);
		this.name = "ReflectionFailure";
		this.code = code;
		this.stage = stage;
	}
	get label(): string {
		return REFLECTION_FAILURE_LABELS[this.code];
	}
}

const SECRET_LIKE = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\b(?:api[_-]?key|token|secret|password)=\S+/gi];

/** Texto técnico do erro para log/registro: uma linha, sem chaves, no máximo `max` caracteres. */
export function describeReflectionError(error: unknown, max = 300): string {
	const raw = error instanceof Error ? `${error.name !== "Error" ? `${error.name}: ` : ""}${error.message}` : typeof error === "string" ? error : "erro desconhecido";
	let out = raw.replace(/\s+/g, " ").trim();
	for (const pattern of SECRET_LIKE) out = out.replace(pattern, "[redacted]");
	return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Classifica um erro lançado em `stage`; idempotente para `ReflectionFailure`. */
export function toReflectionFailure(error: unknown, stage: ReflectionFailureStage): ReflectionFailure {
	if (error instanceof ReflectionFailure) return error;
	const technical = describeReflectionError(error);
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : "";
	const status = typeof (error as { status?: unknown } | null)?.status === "number" ? ((error as { status: number }).status) : undefined;
	const prismaCode = (error as { code?: unknown } | null)?.code;
	const make = (code: ReflectionFailureCode) => new ReflectionFailure(code, stage, technical, { cause: error });

	if (/^PrismaClient/.test(name) || (typeof prismaCode === "string" && /^P\d{4}$/.test(prismaCode))) return make("db_error");
	if (name === "TimeoutError" || name === "AbortError" || /timeout|deadline exceeded|timed out/i.test(message)) return make(stage === "model" ? "model_timeout" : "unknown");
	if (stage === "model" || name === "OpenRouterError" || name === "LlmProviderError") {
		if (/tool|function.?call/i.test(message) && /support|endpoint|no .*found|invalid/i.test(message)) return make("model_no_tools");
		if (status === 401 || status === 403) return make("model_auth");
		if (status === 402) return make("model_credits");
		if (status === 404) return make("model_unavailable");
		if (status === 429) return make("model_rate_limited");
		if (status !== undefined && status >= 500) return make("model_down");
		return make("model_error");
	}
	if (stage === "post") return make("post_failed");
	return make("unknown");
}

/** Linha de log estruturada da falha (sem segredos). */
export function reflectionFailureLogLine(userId: string, failure: ReflectionFailure): string {
	return `[reflection] user=${userId} falhou: ${failure.code} stage=${failure.stage} ${failure.message}`;
}
