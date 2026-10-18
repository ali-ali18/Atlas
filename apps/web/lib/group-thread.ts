import type { GroupMember } from "@workspace/shared";
import type { Message, MessageAuthor } from "@/components/ui/templates/template-4/data";
import type { GroupPosition } from "@/components/ui/templates/template-4/chat-thread/bubble-radius";

/**
 * Conversa de grupo (puro). Falas seguidas do mesmo membro formam um grupo de
 * balões: o nome (e o avatar) aparece só no primeiro; as pontas dos balões se
 * conectam como no chat de um bot. Fala do usuário, card ou separador de horário
 * quebram o grupo.
 */

export type GroupBubbleLayout = {
	/** Primeiro balão do membro: mostra avatar e nome. */
	first: boolean;
	position: GroupPosition;
	/** Chave estável do autor (id, senão nome). */
	authorKey: string;
};

export function authorKeyOf(author: MessageAuthor | undefined): string {
	return author?.id ?? author?.name?.trim().toLowerCase() ?? "";
}

/**
 * Atribui o autor ao vivo às falas do bot sem autor (balão em streaming, ainda não
 * gravado). A atribuição é gravada em `stamped` na primeira vez e nunca muda: sem
 * isso, quando outro membro assume a vez, todas as falas sem autor da sessão
 * passariam a ser dele (e o avatar de todos trocaria).
 */
export function withLiveAuthor(
	messages: readonly Message[],
	liveAuthor: MessageAuthor | null | undefined,
	stamped: Map<string, MessageAuthor> = new Map(),
): Message[] {
	return messages.map((message) => {
		if (message.kind !== "assistant" || message.author || message.bot) return message;
		const known = stamped.get(message.id);
		if (known) return { ...message, author: known };
		if (!liveAuthor) return message;
		stamped.set(message.id, liveAuthor);
		return { ...message, author: liveAuthor };
	});
}

export function groupBubbleLayouts(
	messages: readonly Message[],
	separators: ReadonlyMap<string, string> = new Map(),
): Map<string, GroupBubbleLayout> {
	const layouts = new Map<string, GroupBubbleLayout>();
	const keyAt = (index: number): string | null => {
		const message = messages[index];
		if (!message || message.kind !== "assistant") return null;
		return authorKeyOf(message.author) || "?";
	};
	for (let index = 0; index < messages.length; index += 1) {
		const key = keyAt(index);
		const message = messages[index]!;
		if (key === null) continue;
		const prevSame = keyAt(index - 1) === key && !separators.has(message.id);
		const nextMessage = messages[index + 1];
		const nextSame = keyAt(index + 1) === key && !(nextMessage && separators.has(nextMessage.id));
		const position: GroupPosition = !prevSame && !nextSame ? "single" : !prevSame ? "first" : !nextSame ? "last" : "middle";
		layouts.set(message.id, { first: !prevSame, position, authorKey: key });
	}
	return layouts;
}

/** Quem está respondendo agora, a partir do estado do servidor. */
export function typingLabel(names: readonly string[]): string {
	if (names.length === 0) return "";
	if (names.length === 1) return `${names[0]} está digitando…`;
	const head = names.slice(0, -1).join(", ");
	return `${head} e ${names[names.length - 1]} estão digitando…`;
}

export type GroupReplyLite = { botId: string; status: string };

/** Nomes (na ordem da fila) de quem está respondendo (`running`) e de quem espera (`pending`). */
export function groupActivity(
	replies: readonly GroupReplyLite[],
	members: readonly Pick<GroupMember, "id" | "name">[],
): { running: string[]; waiting: string[] } {
	const nameOf = (id: string) => members.find((member) => member.id === id)?.name;
	const running: string[] = [];
	const waiting: string[] = [];
	for (const reply of replies) {
		const name = nameOf(reply.botId);
		if (!name) continue;
		if (reply.status === "running" && !running.includes(name)) running.push(name);
		else if (reply.status === "pending" && !waiting.includes(name) && !running.includes(name)) waiting.push(name);
	}
	return { running, waiting };
}

/** Mensagem do usuário que o servidor ainda vai rotear: quem vai responder ainda não foi escolhido. */
export function groupRoutingLabel(state: { routing: boolean; replies: readonly unknown[] } | null | undefined): string {
	return state?.routing && state.replies.length === 0 ? "Escolhendo quem responde…" : "";
}

/** Ordem de exibição dos membros: o bot principal primeiro, depois a ordem de criação do grupo. */
export function orderMembers<T extends { id: string; isPrimary?: boolean }>(members: readonly T[]): T[] {
	return [...members].sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
}

/**
 * Linha de status da coordenação com Jev: "Ana está coordenando: Bia, Caio trabalhando…"
 * enquanto há subtarefas em aberto; "Ana está consolidando o resultado…" no resumo.
 * Vazio fora da coordenação (fluxo base não muda nada).
 */
export function coordinationLabel(
	state: { replies: readonly { botId: string; status: string; role?: string | null }[]; coordinatorBotId?: string | null } | null | undefined,
	members: readonly Pick<GroupMember, "id" | "name">[],
): string {
	if (!state?.coordinatorBotId) return "";
	const nameOf = (id: string) => members.find((member) => member.id === id)?.name;
	const coordinator = nameOf(state.coordinatorBotId);
	if (!coordinator) return "";
	const open = state.replies.filter((reply) => reply.status === "running" || reply.status === "pending");
	if (open.some((reply) => reply.role === "summary")) return `${coordinator} está consolidando o resultado…`;
	const workers: string[] = [];
	for (const reply of [...open.filter((item) => item.status === "running"), ...open.filter((item) => item.status === "pending")]) {
		const name = reply.role === "worker" ? nameOf(reply.botId) : undefined;
		if (name && !workers.includes(name)) workers.push(name);
	}
	if (workers.length === 0) return "";
	return `${coordinator} está coordenando: ${workers.join(", ")} trabalhando…`;
}
