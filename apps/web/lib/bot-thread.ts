import type { BotTag, Message } from "@/components/ui/templates/template-4/data";

/**
 * Conversa entre bots na thread (puro). O texto cru trocado entre bots não vira
 * balão normal:
 *  - resposta que chega ao remetente  -> marcador "Mensagem de X";
 *  - pedido que chega ao destino e as falas dele ao atendê-lo -> uma linha
 *    "N mensagens com X", expansível.
 */

export type BotMessage = Extract<Message, { kind: "user" | "assistant" }> & { bot: BotTag };

export type BotPartner = { id?: string; name: string };

export type ThreadItem =
	| { type: "message"; id: string; createdAt?: string; message: Message }
	| { type: "bot-reply"; id: string; createdAt?: string; message: BotMessage; partner: BotPartner }
	| { type: "bot-group"; id: string; createdAt?: string; messages: BotMessage[]; partners: BotPartner[] };

function isBotMessage(message: Message): message is BotMessage {
	return (message.kind === "user" || message.kind === "assistant") && Boolean(message.bot);
}

function partnerOf(message: BotMessage): BotPartner | null {
	const name = message.bot.fromBotName?.trim();
	if (!name) return null;
	return { ...(message.bot.fromBotId ? { id: message.bot.fromBotId } : {}), name };
}

function uniquePartners(messages: readonly BotMessage[]): BotPartner[] {
	const seen = new Set<string>();
	const out: BotPartner[] = [];
	for (const message of messages) {
		const partner = partnerOf(message);
		if (!partner) continue;
		const key = partner.id ?? partner.name;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(partner);
	}
	return out;
}

export function groupBotMessages(messages: readonly Message[]): ThreadItem[] {
	const items: ThreadItem[] = [];
	let run: BotMessage[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const onlyReplies = run.every((message) => message.bot.kind === "reply");
		if (onlyReplies) {
			for (const message of run) {
				items.push({
					type: "bot-reply",
					id: message.id,
					createdAt: message.createdAt,
					message,
					partner: partnerOf(message) ?? { name: "outro bot" },
				});
			}
		} else {
			const first = run[0]!;
			items.push({ type: "bot-group", id: first.id, createdAt: first.createdAt, messages: run, partners: uniquePartners(run) });
		}
		run = [];
	};
	for (const message of messages) {
		if (isBotMessage(message)) {
			run.push(message);
			continue;
		}
		flush();
		items.push({ type: "message", id: message.id, createdAt: message.createdAt, message });
	}
	flush();
	return items;
}

/** "3 mensagens com Ana", "2 mensagens com Ana e Bia", "1 mensagem com outro bot". */
export function botGroupLabel(count: number, partners: readonly BotPartner[]): string {
	const noun = count === 1 ? "mensagem" : "mensagens";
	const names = partners.map((partner) => partner.name);
	let who: string;
	if (names.length === 0) who = "outro bot";
	else if (names.length === 1) who = names[0]!;
	else if (names.length === 2) who = `${names[0]} e ${names[1]}`;
	else who = `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
	return `${count} ${noun} com ${who}`;
}
