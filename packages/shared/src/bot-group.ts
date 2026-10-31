/**
 * Grupos de bots: regras puras (menções, roteamento, limites, transcrição e
 * prompts). Sem I/O. Um grupo é um `Bot` com `memberIds` (2+ bots do dono) e
 * conversa própria; o usuário e os membros falam na mesma conversa.
 */

export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 8;
/** Quantos membros o roteador escolhe, no máximo, para uma fala sem menção. */
export const GROUP_ROUTED_MAX_REPLIES = 2;
/** Quantos membros mencionados pelo usuário respondem (os demais são ignorados). */
export const GROUP_MENTION_MAX_REPLIES = 4;
/** Respostas de bots num mesmo turno do usuário (inclui as disparadas por menção entre bots). */
export const GROUP_TURN_MAX_BOT_REPLIES = 6;
/** Saltos: usuário → bot (1) → bot mencionado (2) → bot mencionado (3). O 4º não dispara. */
export const GROUP_MAX_DEPTH = 3;
/** Mensagens recentes da conversa do grupo que o membro recebe como contexto. */
export const GROUP_TRANSCRIPT_LIMIT = 30;
const GROUP_LINE_MAX_CHARS = 2_000;
const GROUP_USER_LABEL = "Usuário";

export type GroupMember = {
	id: string;
	name: string;
	description?: string | null;
	snippet?: string | null;
	isPrimary?: boolean;
};

export type GroupReplyReason = "user_mention" | "named" | "router" | "primary" | "bot_mention" | "jev" | "coordinator" | "assigned" | "summary" | "nudge";

export type GroupMention = { botId: string; name: string; start: number; end: number };

/** Sem acento, minúsculo (1 caractere de saída por caractere de entrada). */
function foldChar(char: string): string {
	const folded = char.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
	return folded.length === 1 ? folded : (char.toLowerCase().length === 1 ? char.toLowerCase() : char);
}

export function foldText(value: string): string {
	let out = "";
	for (const char of value) out += foldChar(char);
	return out;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && char !== "" && WORD_CHAR.test(char);
}

type Alias = { botId: string; name: string; alias: string };

/** Nome completo de cada membro e, quando único entre todos, a primeira palavra. */
function buildAliases(members: readonly GroupMember[]): Alias[] {
	const full = members.map((member) => ({ botId: member.id, name: member.name, alias: foldText(member.name.trim()) })).filter((a) => a.alias);
	const firstCounts = new Map<string, number>();
	for (const entry of full) {
		const first = entry.alias.split(/\s+/)[0]!;
		firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
	}
	const fullSet = new Set(full.map((entry) => entry.alias));
	const out: Alias[] = [...full];
	for (const entry of full) {
		const first = entry.alias.split(/\s+/)[0]!;
		if (first !== entry.alias && firstCounts.get(first) === 1 && !fullSet.has(first)) {
			out.push({ botId: entry.botId, name: entry.name, alias: first });
		}
	}
	return out.sort((a, b) => b.alias.length - a.alias.length);
}

/** Fim (exclusivo) do trecho de `text` que casa com `alias` a partir de `from`, ou -1. */
function matchAliasAt(text: string, from: number, alias: string): number {
	const chars = [...alias];
	let index = from;
	for (const expected of chars) {
		const char = text[index];
		if (char === undefined || foldChar(char) !== expected) return -1;
		index += 1;
	}
	return isWordChar(text[index]) ? -1 : index;
}

/**
 * Menções `@Nome` a membros do grupo, na ordem do texto. Casa o nome completo
 * (sem acento/caixa) ou a primeira palavra quando ela é única entre os membros.
 * Ignora `@` colado a uma palavra (e-mail) e menções dentro de blocos de código.
 */
export function parseGroupMentions(text: string, members: readonly GroupMember[]): GroupMention[] {
	if (!text.includes("@") || members.length === 0) return [];
	const aliases = buildAliases(members);
	const mentions: GroupMention[] = [];
	let inFence = false;
	let offset = 0;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
		} else if (!inFence) {
			for (let i = 0; i < line.length; i += 1) {
				if (line[i] !== "@") continue;
				if (i > 0 && (isWordChar(line[i - 1]) || line[i - 1] === "." || line[i - 1] === "@")) continue;
				for (const candidate of aliases) {
					const end = matchAliasAt(line, i + 1, candidate.alias);
					if (end < 0) continue;
					mentions.push({ botId: candidate.botId, name: candidate.name, start: offset + i, end: offset + end });
					i = end - 1;
					break;
				}
			}
		}
		offset += line.length + 1;
	}
	return mentions;
}

/** Ids mencionados, únicos, na ordem em que aparecem. */
export function mentionedBotIds(text: string, members: readonly GroupMember[]): string[] {
	const seen = new Set<string>();
	for (const mention of parseGroupMentions(text, members)) seen.add(mention.botId);
	return [...seen];
}

/** Partes do texto para a UI: texto puro e chips de menção. */
export type GroupTextPart = { type: "text"; text: string } | { type: "mention"; text: string; botId: string };

export function splitGroupMentions(text: string, members: readonly GroupMember[]): GroupTextPart[] {
	const mentions = parseGroupMentions(text, members);
	if (mentions.length === 0) return [{ type: "text", text }];
	const parts: GroupTextPart[] = [];
	let cursor = 0;
	for (const mention of mentions) {
		if (mention.start > cursor) parts.push({ type: "text", text: text.slice(cursor, mention.start) });
		parts.push({ type: "mention", text: text.slice(mention.start, mention.end), botId: mention.botId });
		cursor = mention.end;
	}
	if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
	return parts;
}

/** Autocompletar `@`: a consulta digitada logo antes do cursor, ou null. */
export function activeMentionQuery(text: string, caret: number): { query: string; start: number } | null {
	const before = text.slice(0, caret);
	const at = before.lastIndexOf("@");
	if (at < 0) return null;
	if (at > 0 && isWordChar(before[at - 1])) return null;
	const query = before.slice(at + 1);
	if (/[\n]/.test(query) || query.length > 40) return null;
	return { query, start: at };
}

/** Membros que casam com a consulta do autocompletar (prefixo do nome/palavra), em ordem. */
export function filterMentionCandidates<T extends GroupMember>(members: readonly T[], query: string): T[] {
	const wanted = foldText(query.trim());
	if (!wanted) return [...members];
	return members.filter((member) =>
		foldText(member.name)
			.split(/\s+/)
			.some((word) => word.startsWith(wanted)) || foldText(member.name).startsWith(wanted),
	);
}

const STOPWORDS = new Set([
	"para", "como", "qual", "quais", "esse", "essa", "isso", "este", "esta", "isto", "mais", "muito", "pode", "poderia", "preciso",
	"quero", "gostaria", "sobre", "ajuda", "ajudar", "favor", "fazer", "feito", "voce", "voces", "tambem", "entre", "quando",
	"onde", "porque", "pois", "tudo", "todos", "todas", "algum", "alguma", "ainda", "depois", "antes", "bot", "bots", "grupo",
	"ola", "oi", "bom", "boa", "dia", "tarde", "noite", "obrigado", "obrigada", "uma", "uns", "umas", "com", "sem", "por",
	"que", "dos", "das", "nos", "nas", "seu", "sua", "meu", "minha", "tem", "ter", "sao", "foi", "ser", "sera", "vai", "vou",
]);

function significantWords(value: string): Set<string> {
	const out = new Set<string>();
	for (const raw of foldText(value).split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < 4 || STOPWORDS.has(raw)) continue;
		out.add(raw.length > 5 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
	}
	return out;
}

/** Nome do membro escrito como palavra no texto (sem `@`): "Bia, quanto deu o caixa?". */
function addressedByName(text: string, member: GroupMember): boolean {
	const name = foldText(member.name.trim());
	if (!name) return false;
	const hay = foldText(text);
	let from = 0;
	while (from <= hay.length) {
		const found = hay.indexOf(name, from);
		if (found < 0) return false;
		const beforeChar = hay[found - 1];
		const afterChar = hay[found + name.length];
		if (!isWordChar(beforeChar) && !isWordChar(afterChar)) return true;
		from = found + 1;
	}
	return false;
}

export type MemberScore = { id: string; score: number };

/** Pontuação barata por papel: palavras do texto presentes na descrição/rótulo do membro. */
export function scoreMembersForText(text: string, members: readonly GroupMember[]): MemberScore[] {
	const words = significantWords(text);
	return members.map((member) => {
		const about = significantWords(`${member.description ?? ""} ${member.snippet ?? ""} ${member.name}`);
		let score = 0;
		for (const word of words) if (about.has(word)) score += 1;
		return { id: member.id, score };
	});
}

export type GroupRoute = {
	ids: string[];
	reason: GroupReplyReason;
	/** Sem sinal nenhum e sem bot principal: vale uma chamada ao roteador (LLM barato). */
	needsLlm: boolean;
};

/**
 * Quem responde a uma fala do usuário:
 *  1. `@menções` → só os mencionados (até GROUP_MENTION_MAX_REPLIES);
 *  2. nome citado sem `@` ("Bia, ...") → esses membros;
 *  3. sinal forte de papel (palavras da descrição) → até GROUP_ROUTED_MAX_REPLIES;
 *  4. o bot principal, se for membro;
 *  5. senão `needsLlm` (e, sem LLM, o primeiro membro).
 */
export function routeGroupMessage(input: { text: string; members: readonly GroupMember[] }): GroupRoute {
	const { text, members } = input;
	const mentioned = mentionedBotIds(text, members);
	if (mentioned.length > 0) {
		return { ids: mentioned.slice(0, GROUP_MENTION_MAX_REPLIES), reason: "user_mention", needsLlm: false };
	}
	const named = members.filter((member) => addressedByName(text, member)).map((member) => member.id);
	if (named.length > 0) {
		return { ids: named.slice(0, GROUP_MENTION_MAX_REPLIES), reason: "named", needsLlm: false };
	}
	const scores = scoreMembersForText(text, members).sort((a, b) => b.score - a.score);
	const top = scores[0];
	if (top && top.score >= 2) {
		const ids = scores.filter((entry) => entry.score >= Math.max(2, top.score * 0.7)).slice(0, GROUP_ROUTED_MAX_REPLIES).map((entry) => entry.id);
		return { ids, reason: "router", needsLlm: false };
	}
	const primary = members.find((member) => member.isPrimary);
	if (primary) return { ids: [primary.id], reason: "primary", needsLlm: false };
	if (top && top.score >= 1 && scores[1]?.score !== top.score) return { ids: [top.id], reason: "router", needsLlm: false };
	return { ids: members[0] ? [members[0].id] : [], reason: "router", needsLlm: members.length > 1 };
}

/** Prompt do roteador (uma chamada barata). Genérico: não cita o produto. */
export function buildGroupRouterPrompt(input: { groupName: string; text: string; members: readonly GroupMember[] }): { system: string; user: string } {
	const list = input.members
		.map((member) => {
			const about = (member.description?.trim() || member.snippet?.trim() || "sem descrição").replace(/\s+/g, " ").slice(0, 160);
			return `- ${member.name} (id: ${member.id}): ${about}`;
		})
		.join("\n");
	return {
		system:
			`Você escolhe quem responde numa conversa em grupo entre o usuário e vários bots. Escolha de 1 a ${GROUP_ROUTED_MAX_REPLIES} membros cujo papel melhor serve à mensagem; prefira apenas 1 quando um basta. ` +
			'Responda SOMENTE com JSON no formato {"bots":["id"]}, sem texto extra.',
		user: `Grupo: ${input.groupName}\nMembros:\n${list}\n\nMensagem do usuário:\n${input.text.slice(0, 1_500)}`,
	};
}

/** Lê a resposta do roteador (JSON, ids ou nomes) e devolve ids válidos, únicos, no teto. */
export function parseGroupRouterReply(reply: string, members: readonly GroupMember[]): string[] {
	const ids = new Set(members.map((member) => member.id));
	const picked: string[] = [];
	const push = (id: string) => {
		if (ids.has(id) && !picked.includes(id)) picked.push(id);
	};
	const jsonMatch = /\{[\s\S]*\}/.exec(reply);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as { bots?: unknown };
			if (Array.isArray(parsed.bots)) {
				for (const item of parsed.bots) {
					if (typeof item !== "string") continue;
					if (ids.has(item)) {
						push(item);
						continue;
					}
					const byName = members.find((member) => foldText(member.name) === foldText(item));
					if (byName) push(byName.id);
				}
			}
		} catch {
			// cai para a leitura por texto
		}
	}
	if (picked.length === 0) {
		for (const member of members) {
			if (reply.includes(member.id) || addressedByName(reply, member)) push(member.id);
		}
	}
	return picked.slice(0, GROUP_ROUTED_MAX_REPLIES);
}

export type FollowUp = { botId: string; depth: number };

/**
 * Respostas disparadas por menções na fala de um bot. Sem laço: ninguém dispara a
 * si mesmo, quem já está na fila do turno não entra de novo, a profundidade e o
 * total de respostas do turno têm teto.
 */
export function planGroupFollowUps(input: {
	text: string;
	members: readonly GroupMember[];
	authorId: string;
	depth: number;
	/** Respostas do turno já criadas (qualquer status). */
	turnReplyCount: number;
	/** Bots com resposta ainda na fila (`pending`/`running`) no turno. */
	queuedBotIds: readonly string[];
}): FollowUp[] {
	const depth = input.depth + 1;
	if (depth > GROUP_MAX_DEPTH) return [];
	let room = GROUP_TURN_MAX_BOT_REPLIES - input.turnReplyCount;
	if (room <= 0) return [];
	const queued = new Set(input.queuedBotIds);
	const out: FollowUp[] = [];
	for (const id of mentionedBotIds(input.text, input.members)) {
		if (id === input.authorId || queued.has(id)) continue;
		if (room <= 0) break;
		out.push({ botId: id, depth });
		room -= 1;
	}
	return out;
}

export type GroupTranscriptRow = {
	role: string;
	content: string;
	fromBotId?: string | null;
	fromBotName?: string | null;
};

export type GroupLlmMessage = { role: "user" | "assistant"; content: string };

function clip(value: string): string {
	return value.length > GROUP_LINE_MAX_CHARS ? `${value.slice(0, GROUP_LINE_MAX_CHARS)}…` : value;
}

/**
 * Conversa do grupo vista por UM membro: as falas dele são `assistant`; as do
 * usuário e dos outros viram `user` com o autor no início ("Bia: ..."), emendadas
 * quando seguidas (alguns provedores não aceitam dois `user` seguidos).
 */
export function groupTranscriptForBot(rows: readonly GroupTranscriptRow[], selfId: string, limit = GROUP_TRANSCRIPT_LIMIT): GroupLlmMessage[] {
	const out: GroupLlmMessage[] = [];
	for (const row of rows.slice(-limit)) {
		const content = row.content.trim();
		if (!content) continue;
		if (row.role === "assistant" && row.fromBotId === selfId) {
			out.push({ role: "assistant", content: clip(content) });
			continue;
		}
		if (row.role !== "user" && row.role !== "assistant") continue;
		const author = row.role === "user" ? GROUP_USER_LABEL : row.fromBotName?.trim() || "Bot";
		const line = `${author}: ${clip(content)}`;
		const last = out[out.length - 1];
		if (last && last.role === "user") last.content = `${last.content}\n\n${line}`;
		else out.push({ role: "user", content: line });
	}
	return out;
}

const oneLine = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

/** Bloco do prompt de um membro dentro do grupo (substitui o roster do `send_to_bot`). */
export function buildGroupSection(input: { groupName: string; selfId: string; members: readonly GroupMember[] }): string {
	const self = input.members.find((member) => member.id === input.selfId);
	const list = input.members
		.map((member) => {
			const about = oneLine(member.description?.trim() || member.snippet?.trim() || "", 140);
			const tags = `${member.id === input.selfId ? " (você)" : ""}${member.isPrimary ? " [principal]" : ""}`;
			return `- ${oneLine(member.name, 60)}${tags}${about ? `: ${about}` : ""}`;
		})
		.join("\n");
	const lines = [
		`════ GRUPO "${oneLine(input.groupName, 80)}" ════`,
		`Você${self ? ` (${oneLine(self.name, 60)})` : ""} está numa conversa em grupo com o usuário e estes bots:`,
		list,
		"",
		'No histórico, as falas do usuário e dos outros bots vêm como "Nome: texto"; as suas vêm sem prefixo.',
		"Responda só com o seu texto, sem escrever o seu nome na frente. Seja direto e útil, fale só do que é do seu papel e não repita o que outro membro já disse. Se nada a acrescentar, diga isso em uma frase curta.",
		"Para chamar outro membro, escreva @Nome no texto (ele responde em seguida). Mencione só quando precisar mesmo da contribuição dele; nunca mencione a si mesmo nem devolva o pedido a quem acabou de te chamar.",
		"Neste grupo não use send_to_bot: o canal é a própria conversa. Use suas ferramentas, memória e conectores normalmente; o que o grupo disse só vira memória sua se você salvar de propósito.",
	];
	return lines.join("\n");
}

/** Regra (para o modelo) contra "fico aguardando X": vale para coordenador e membros. */
export const GROUP_NO_WAIT_RULE =
	"Never end with 'waiting for X' or ask the user/another bot for things already in the conversation. If a dependency is missing, make the most reasonable assumption, deliver, and list assumptions.";

/** Última mensagem do turno: diz ao membro por que é a vez dele. */
export function buildGroupTurnPrompt(input: { groupName: string; reason: GroupReplyReason; fromName?: string | null }): string {
	const group = `"${oneLine(input.groupName, 80)}"`;
	switch (input.reason) {
		case "user_mention":
			return `[Grupo ${group}] O usuário mencionou você. Responda ao grupo.`;
		case "named":
			return `[Grupo ${group}] O usuário se dirigiu a você pelo nome. Responda ao grupo.`;
		case "bot_mention":
			return `[Grupo ${group}] ${input.fromName ? oneLine(input.fromName, 60) : "Outro membro"} mencionou você. Responda ao grupo, ao que foi pedido a você. ${GROUP_NO_WAIT_RULE}`;
		default:
			return `[Grupo ${group}] A mensagem do usuário foi encaminhada a você por ser da sua área. Responda ao grupo.`;
	}
}

// ---- Tipos de API (web <-> api) ----

export type GroupReplyView = {
	id: string;
	botId: string;
	status: string;
	runId: string | null;
	depth: number;
	/** Só na coordenação com Jev: coordinator | worker | summary. */
	role?: string | null;
};

export type GroupStateResponse = {
	/** Turno ainda decidindo quem responde. */
	routing: boolean;
	/** Respostas na fila (`pending`) ou em andamento (`running`), na ordem. */
	replies: GroupReplyView[];
	/** Coordenador do turno em andamento (coordenação com Jev), se houver. */
	coordinatorBotId?: string | null;
};

export type PostGroupMessageResponse = { messageId: string; turnId: string };

export type CreateGroupInput = {
	name: string;
	memberIds: string[];
	color?: string;
	shape?: string;
};

export function isGroupBot(bot: { memberIds?: readonly string[] | null }): boolean {
	return (bot.memberIds?.length ?? 0) > 0;
}

/** Valida a lista de membros de um grupo (só formato; posse se confere no banco). */
export function normalizeGroupMemberIds(ids: readonly unknown[]): string[] | null {
	const out: string[] = [];
	for (const item of ids) {
		if (typeof item !== "string" || !item.trim()) return null;
		if (!out.includes(item.trim())) out.push(item.trim());
	}
	if (out.length < GROUP_MIN_MEMBERS || out.length > GROUP_MAX_MEMBERS) return null;
	return out;
}
