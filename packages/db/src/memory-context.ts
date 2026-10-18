import type { ChatMessage, ChatRole, SessionMessage } from "@workspace/shared";
import {
	buildBotRosterSection,
	buildGroupSection,
	composeTieredMessages,
	groupTranscriptForBot,
	isLlmChatRole,
	placeVolatileBeforeTurn,
	GROUP_TRANSCRIPT_LIMIT,
	type GroupMember,
} from "@workspace/shared";
import {
	appendConversationMessage,
	loadRecentConversationMessages,
} from "./conversations.js";
import { getBotIdentity } from "./bots.js";
import { listUserBotRoster } from "./bot-messages.js";
import { botDecidesForOthers } from "./bot-pending.js";
import { renderMemoryTiers } from "./memory-search.js";
import {
	getLatestSummary,
	renderSummaryBlock,
} from "./summaries.js";

export type MemoryContextOptions = {
	userId?: string;
	botId?: string;
	conversationId?: string;
	messageLimit?: number;
	/**
	 * Fase 2 — ciclo limpo: resumo obrigatório + cauda mínima, sem as 40.
	 * Sem resumo não há ciclo: cai no caminho completo. UI/DB intactos.
	 */
	compact?: boolean;
	/**
	 * Run de um membro na conversa de um grupo: o histórico vira a transcrição do grupo
	 * (falas dos outros com autor) e o prompt traz o bloco do grupo no lugar do roster.
	 */
	group?: { name: string; selfId: string; members: GroupMember[] };
};

/**
 * F2 — ordem do prompt pensada para o cache por prefixo: identidade, perfil e
 * resumo (mudam raramente) antes do histórico; a memória por relevância (depende
 * da pergunta atual) depois dele, colada ao turno. Pura: sem I/O.
 */
export function assembleMemoryContext(input: {
	identity: string | null;
	profile: string | null;
	summary: string | null;
	relevantMemory: string | null;
	sessionMessages: ChatMessage[];
	incoming: ChatMessage[];
}): ChatMessage[] {
	const lastIncoming = input.incoming[input.incoming.length - 1];
	// O histórico pode já vir em `incoming` (o worker o carrega antes): a janela de sessão só traz o que
	// ainda não está lá, para cada fala aparecer uma vez só (par papel+texto, contando repetições).
	const carried = new Map<string, number>();
	for (const message of input.incoming.slice(0, -1)) {
		const key = JSON.stringify([message.role, message.content]);
		carried.set(key, (carried.get(key) ?? 0) + 1);
	}
	// Do fim para o começo: as cópias que `incoming` já tem são as mais recentes; as antigas sobram.
	const sessionMessages = [...input.sessionMessages]
		.reverse()
		.filter((message) => {
			const key = JSON.stringify([message.role, message.content]);
			const left = carried.get(key) ?? 0;
			if (left <= 0) return true;
			carried.set(key, left - 1);
			return false;
		})
		.reverse();
	const all: ChatMessage[] = [...sessionMessages, ...input.incoming.slice(0, -1)];
	if (lastIncoming) {
		const lastSession = sessionMessages[sessionMessages.length - 1];
		const duplicateLast =
			lastSession?.role === lastIncoming.role && lastSession.content === lastIncoming.content;
		if (!duplicateLast) all.push(lastIncoming);
	}

	return composeTieredMessages({
		context: [input.identity, input.profile, input.summary],
		history: placeVolatileBeforeTurn(all, [input.relevantMemory]),
		volatile: [],
	});
}

export async function buildMemoryAugmentedMessages(
	incoming: ChatMessage[],
	options: MemoryContextOptions,
): Promise<ChatMessage[]> {
	// Grupo: a pergunta real é a última fala do usuário (o último "user" é só o aviso de turno).
	const groupRows = options.group && options.conversationId
		? await loadRecentConversationMessages(options.conversationId, GROUP_TRANSCRIPT_LIMIT + 10)
		: null;
	const memoryQuery = groupRows
		? ([...groupRows].reverse().find((row) => row.role === "user")?.content ?? "")
		: ([...incoming].reverse().find((m) => m.role === "user")?.content ?? "");
	const memory = await renderMemoryTiers(options.userId, options.botId, memoryQuery);

	// Identidade do bot: sem isso o modelo usa a identidade global ("Atlas")
	// mesmo quando o usuário nomeou o bot (ex.: "TomTom"). Vale para todos
	// os pipelines (agent-run, chat-completion, chat simples). Falha aqui
	// nunca quebra o run: só omite o bloco.
	let identity: string | null = null;
	try {
		if (options.botId) identity = await buildBotIdentityMessage(options.botId, options.userId, options.group);
	} catch (error) {
		console.error("bot identity failed; continuing without identity", error);
	}

	// Resumo da conversa (Fase 1: reinjetado quando existe; Fase 2: ciclo
	// limpo exige resumo — sem ele, cai no caminho completo). Transcript na
	// UI/DB intacto. Falha aqui nunca quebra o run: só omite o bloco.
	let compact = options.compact === true && !options.group;
	let summaryBlock: string | null = null;
	try {
		// Grupo: o resumo da conversa não distingue autores; a transcrição recente basta.
		if (options.group) {
			compact = false;
		} else if (options.conversationId) {
			const summary = await getLatestSummary(options.conversationId);
			if (summary && summary.content.trim()) {
				summaryBlock = renderSummaryBlock(summary);
			} else if (compact) {
				compact = false;
			}
		} else if (compact) {
			compact = false;
		}
	} catch (error) {
		console.error("summary inject failed; continuing without summary", error);
		compact = false;
	}

	let sessionMessages: ChatMessage[] = [];
	// Ciclo limpo: pula a janela de 40 — o incoming já traz a cauda mínima
	// (worker) e o resumo acima ancora o resto.
	let turnMessages = incoming;
	if (options.group && groupRows) {
		sessionMessages = groupTranscriptForBot(groupRows, options.group.selfId).map((m) => ({ role: m.role, content: m.content }));
		// O aviso de turno ("o usuário mencionou você") cola na última fala do grupo: alguns provedores recusam dois `user` seguidos.
		const last = sessionMessages[sessionMessages.length - 1];
		if (last?.role === "user" && incoming.length === 1 && incoming[0]?.role === "user") {
			sessionMessages = [...sessionMessages.slice(0, -1), { role: "user", content: `${last.content}\n\n${incoming[0].content}` }];
			turnMessages = [];
		}
	} else if (options.conversationId && !compact) {
		const recent = await loadRecentConversationMessages(
			options.conversationId,
			options.messageLimit ?? 40,
		);
		sessionMessages = recent
			.filter((m): m is SessionMessage & { role: ChatRole } => isLlmChatRole(m.role))
			.map((m) => ({
				role: m.role,
				content: m.content,
			}));
	}

	const augmented = assembleMemoryContext({
		identity,
		profile: memory.stable,
		summary: summaryBlock,
		relevantMemory: memory.volatile,
		sessionMessages,
		incoming: turnMessages,
	});
	return augmented.length > 0 ? augmented : incoming;
}

/**
 * Bloco `system` com a identidade do bot (nome + papel). O prompt global diz
 * "você é o Atlas" — este bloco especializa por bot para o modelo se
 * apresentar e responder com o nome certo, sem alucinar outra identidade.
 * Retorna `null` sem botId, sem bot ou em erro (caller ignora).
 */
export async function buildBotIdentityMessage(
	botId: string | null | undefined,
	userId: string | undefined,
	group?: { name: string; selfId: string; members: GroupMember[] },
): Promise<string | null> {
	try {
		const identity = await getBotIdentity(botId, userId);
		if (!identity || !identity.name.trim()) return null;
		const name = identity.name.trim().slice(0, 80);
		const lines = [`Você está atuando como o bot "${name}".`];
		const description = identity.description?.trim().slice(0, 500);
		if (description) {
			lines.push(`Papel do bot: ${description}`);
		}
		lines.push(
			`Responda SEMPRE como "${name}" — nunca como Atlas, nunca como outro assistente genérico. Fale SEMPRE em primeira pessoa como "${name}" (diga "vou", nunca "o ${name} vai..."). Apresente-se APENAS no primeiro contato (evento bot-created); em respostas e follow-ups, NÃO se apresente de novo.`,
		);
		const identityBlock = `════ IDENTIDADE DO BOT ════\n${lines.join("\n")}`;
		// Grupo: os outros membros e as regras da conversa no lugar do roster do send_to_bot.
		if (group) {
			return `${identityBlock}\n\n${buildGroupSection({ groupName: group.name, selfId: group.selfId, members: group.members })}`;
		}
		// Roster dos outros bots do usuário (send_to_bot); falha aqui só omite o bloco.
		const roster = userId && botId ? await listUserBotRoster(userId).catch(() => []) : [];
		const rosterBlock = buildBotRosterSection({
			selfId: botId ?? "",
			selfIsPrimary: roster.find((bot) => bot.id === botId)?.isPrimary === true,
			bots: roster,
			decidesForOthers: userId && botId ? await botDecidesForOthers(botId, userId).catch(() => false) : false,
		});
		return rosterBlock ? `${identityBlock}\n\n${rosterBlock}` : identityBlock;
	} catch (error) {
		console.error("bot identity load failed; skipping", error);
		return null;
	}
}

export async function persistChatTurn(
	conversationId: string,
	userContent: string | null,
	assistantContent: string,
): Promise<void> {
	if (userContent && userContent.trim().length > 0) {
		await appendConversationMessage(
			conversationId,
			"user",
			userContent.trim(),
		);
	}
	await appendConversationMessage(
		conversationId,
		"assistant",
		assistantContent.trim(),
	);
}
