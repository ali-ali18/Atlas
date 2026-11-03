// Texto da fala do usuário em trechos (puro): texto, menção a bot (`@Nome`) e habilidade (`/slug`). O balão desenha as
// menções como o marcador do composer (avatar pequeno + nome em azul), em vez do `@Nome` cru. As regras de achar a
// menção são as do servidor e do web (`splitGroupMentions`/`parseSlashSkills` de `@workspace/shared`); menção que não é de
// um bot do usuário, e `/algo` que não é habilidade conhecida, continuam texto.
import { parseSlashSkills, splitGroupMentions } from "@workspace/shared";

export type MentionBotRef = { id: string; name: string; color?: string; shape?: string };

export type MessagePart =
	| { type: "text"; text: string }
	/** `text` é o nome como foi escrito, sem o `@`. */
	| { type: "bot"; text: string; bot: MentionBotRef }
	/** `text` é o slug, sem a `/`. */
	| { type: "skill"; text: string };

function splitSkills(text: string, skills: ReadonlySet<string> | undefined): MessagePart[] {
	if (!skills || skills.size === 0 || !text.includes("/")) return text ? [{ type: "text", text }] : [];
	const parts: MessagePart[] = [];
	let cursor = 0;
	for (const token of parseSlashSkills(text)) {
		if (!skills.has(token.name)) continue;
		if (token.start > cursor) parts.push({ type: "text", text: text.slice(cursor, token.start) });
		parts.push({ type: "skill", text: token.name });
		cursor = token.end;
	}
	if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
	return parts;
}

export function splitMessageText(text: string, bots: readonly MentionBotRef[], skills?: ReadonlySet<string>): MessagePart[] {
	const out: MessagePart[] = [];
	for (const part of splitGroupMentions(text, bots)) {
		if (part.type === "text") {
			out.push(...splitSkills(part.text, skills));
			continue;
		}
		const bot = bots.find((item) => item.id === part.botId);
		out.push(bot ? { type: "bot", text: part.text.replace(/^@/, ""), bot } : { type: "text", text: part.text });
	}
	// Junta textos vizinhos (menção desconhecida entre dois trechos de texto).
	return out.reduce<MessagePart[]>((merged, part) => {
		const last = merged[merged.length - 1];
		if (part.type === "text" && last?.type === "text") last.text += part.text;
		else merged.push(part.type === "text" ? { ...part } : part);
		return merged;
	}, []);
}

/** Só texto (nenhuma menção nem habilidade): o balão desenha o `Text` simples, como antes. */
export const isPlainMessage = (parts: readonly MessagePart[]): boolean => parts.every((part) => part.type === "text");

/** O bot do marcador "Enviou mensagem para X": pelo id e, sem ele (bot apagado ou id velho), pelo nome. Sem achar: `undefined`. */
export function findLinkedBot<T extends { id: string; name: string }>(bots: readonly T[], link: { botId: string; botName: string }): T | undefined {
	const byId = bots.find((bot) => bot.id === link.botId);
	if (byId) return byId;
	const wanted = link.botName.trim().toLowerCase();
	return wanted ? bots.find((bot) => bot.name.trim().toLowerCase() === wanted) : undefined;
}
