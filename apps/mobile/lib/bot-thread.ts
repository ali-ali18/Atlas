// Conversa entre bots no fio do usuário (puro). O texto cru trocado entre bots não é do usuário e não vira balão:
//  - pedido que chega a este bot e as falas dele ao atendê-lo -> uma linha "N mensagens com X";
//  - resposta que chega a quem pediu -> uma linha "Mensagem de X".
// Mesmo modelo do `groupBotMessages` do web (`apps/web/lib/bot-thread.ts`); a conversa em si abre numa tela própria.
import type { BotPartner, BotTag, ChatItem } from "./chat-types";
import { formatRunTime } from "./routine-run";

type BotSpeech = Extract<ChatItem, { kind: "user" | "assistant" }> & { bot: BotTag };
type ExchangeItem = Extract<ChatItem, { kind: "bot-exchange" }>;

export function isBotSpeech(item: ChatItem): item is BotSpeech {
	return (item.kind === "user" || item.kind === "assistant") && Boolean(item.bot);
}

function partnerOf(item: BotSpeech): BotPartner | null {
	const name = item.bot.fromBotName?.trim();
	if (!name) return null;
	return { ...(item.bot.fromBotId ? { id: item.bot.fromBotId } : {}), name };
}

function uniquePartners(items: readonly BotSpeech[]): BotPartner[] {
	const seen = new Set<string>();
	const out: BotPartner[] = [];
	for (const item of items) {
		const partner = partnerOf(item);
		if (!partner) continue;
		const key = partner.id ?? partner.name;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(partner);
	}
	return out;
}

/** Chave da fala a destacar na conversa aberta (a mesma de `exchangeEntryKey`). */
export function exchangeFocus(botMessageId: string | undefined, kind: BotTag["kind"]): string | undefined {
	if (!botMessageId) return undefined;
	return `${botMessageId}:${kind === "request" ? "req" : "reply"}`;
}

/**
 * Troca as falas entre bots por linhas-resumo. Falas seguidas entre bots viram uma linha; qualquer outra coisa (fala
 * do usuário, cartão, marcador) fecha o trecho, então fala do usuário nunca é engolida. A identidade da linha é a da
 * primeira fala (`bot-exchange:<id>`), a mesma ao vivo e restaurada do cache.
 */
export function groupBotItems(items: readonly ChatItem[]): ChatItem[] {
	const out: ChatItem[] = [];
	let run: BotSpeech[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const first = run[0]!;
		if (run.every((item) => item.bot.kind === "reply")) {
			for (const item of run) {
				const partner = partnerOf(item);
				const focus = exchangeFocus(item.bot.botMessageId, "reply");
				out.push({ id: `bot-exchange:${item.id}`, kind: "bot-exchange", direction: "received", count: 1, partners: partner ? [partner] : [], ...(item.createdAt ? { createdAt: item.createdAt } : {}), ...(focus ? { focus } : {}) });
			}
		} else {
			const request = run.find((item) => item.bot.kind === "request") ?? first;
			const focus = exchangeFocus(request.bot.botMessageId, "request");
			out.push({ id: `bot-exchange:${first.id}`, kind: "bot-exchange", direction: "group", count: run.length, partners: uniquePartners(run), ...(first.createdAt ? { createdAt: first.createdAt } : {}), ...(focus ? { focus } : {}) });
		}
		run = [];
	};
	// Um marcador por PARCEIRO: o app abre uma tela por par de bots, então trocar de parceiro fecha o trecho. A fala do
	// bot ao atender (`answer`, sem nome) pertence ao parceiro do pedido anterior.
	let runKey: string | null = null;
	for (const item of items) {
		if (isBotSpeech(item)) {
			const partner = partnerOf(item);
			const key = partner ? (partner.id ?? partner.name) : null;
			if (key && runKey && key !== runKey) flush();
			if (key) runKey = key;
			run.push(item);
			continue;
		}
		runKey = null;
		flush();
		out.push(item);
	}
	flush();
	return out;
}

/** Data e hora que ficam acima da linha: "Hoje 10:00", "Ontem 10:00" ou "03/11 10:00" (no fuso dado, o do aparelho por padrão). */
export function exchangeStamp(iso: string | undefined, now: number, timeZone?: string): string {
	if (!iso) return "";
	const at = formatRunTime(iso, timeZone);
	if (!at) return "";
	const [day, hour] = at.split(" ") as [string, string];
	if (day === formatRunTime(new Date(now).toISOString(), timeZone).split(" ")[0]) return `Hoje ${hour}`;
	if (day === formatRunTime(new Date(now - 24 * 60 * 60 * 1000).toISOString(), timeZone).split(" ")[0]) return `Ontem ${hour}`;
	return at;
}

function namesLabel(names: readonly string[]): string {
	if (names.length === 0) return "outro bot";
	if (names.length === 1) return names[0]!;
	return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

/** "3 mensagens com Ana", "2 mensagens com Ana e Bia", "1 mensagem com outro bot", "Mensagem de Ana". */
export function botExchangeLabel(item: ExchangeItem): string {
	const names = item.partners.map((partner) => partner.name);
	if (item.direction === "received") return `Mensagem de ${namesLabel(names)}`;
	return `${item.count} ${item.count === 1 ? "mensagem" : "mensagens"} com ${namesLabel(names)}`;
}

/** Com quem a linha abre a conversa: o primeiro parceiro com id (sem id, a linha é só informativa). */
export function exchangePeerId(item: ExchangeItem): string | null {
	return item.partners.find((partner) => partner.id)?.id ?? null;
}
