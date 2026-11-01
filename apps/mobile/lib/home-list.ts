// Montagem da home: fixados em grade, seções recolhíveis e busca local. Funções puras (testadas em
// home-list.test.ts), no mesmo molde da barra lateral do web (chat-sidebar/chat-sidebar.tsx e agent-list.tsx):
// fixado fica só na zona de fixados (fixar e seção são exclusivos), seção some se vazia, e quem não tem seção
// (ou aponta para uma que não existe) vai para "Sem sessão".
import { parseBotLinkCard, sourcePreviewPrefix, type Bot } from "@workspace/shared";
import type { HomeBot, SectionRef } from "./home-types";

export const NO_SECTION_KEY = "__sem-sessao";
export const NO_SECTION_TITLE = "Sem sessão";

export type HomeSection = { key: string; title: string; bots: HomeBot[] };
export type HomeLayout = { pinned: HomeBot[]; sections: HomeSection[] };

/** A prévia guardada (e portanto o cache) nunca passa disto. */
export const PREVIEW_MAX_CHARS = 140;

/** Sem acento, sem caixa: "Sênior" casa com "senior". */
export function foldText(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Tira a marcação markdown da prévia (a mesma limpeza do `stripMarkdownPreview` do web). */
export function stripMarkdownPreview(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|\n?```/g, " "))
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.*?)\1/g, "$2")
		.replace(/(^|\W)\*(?!\s)(.*?)(?<!\s)\*(?!\w)/g, "$1$2")
		.replace(/(^|\W)_(?!\s)(.*?)(?<!\s)_(?!\w)/g, "$1$2")
		.replace(/~~(.*?)~~/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/^(\s*[-*+]|\s*\d+[.)])\s+/gm, "")
		.replace(/^([-*_]){3,}\s*$/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

export type RowPreview = { text: string; /** Mensagem que este bot mandou para outro bot (ícone de envio). */ sent: boolean };

/** Prévia da última mensagem: "Enviou mensagem para X: título" quando é o marcador de bot, senão o texto limpo. */
export function previewOf(bot: Pick<Bot, "lastMessage">): RowPreview {
	const last = bot.lastMessage;
	if (!last) return { text: "", sent: false };
	if (last.role === "bot-link") {
		const card = parseBotLinkCard(last.content);
		if (card) return { text: `Enviou mensagem para ${card.botName}${card.title ? `: ${card.title}` : ""}`, sent: true };
		return { text: "", sent: false };
	}
	const prefix = sourcePreviewPrefix(last.source);
	const body = stripMarkdownPreview(last.content);
	return { text: prefix ? `${prefix} · ${body}` : body, sent: false };
}

/** Cópia enxuta do bot, só com o que a home desenha; a prévia sai pronta e truncada. */
export function toHomeBot(bot: Bot): HomeBot {
	const preview = previewOf(bot);
	return {
		id: bot.id,
		name: bot.name,
		color: bot.color,
		shape: bot.shape,
		pinned: bot.pinned === true,
		pinOrder: typeof bot.pinOrder === "number" ? bot.pinOrder : null,
		sectionId: bot.sectionId ?? null,
		memberIds: bot.memberIds,
		isPrimary: bot.isPrimary === true,
		unread: (bot.unreadCount ?? 0) > 0 || bot.manualUnread === true,
		lastAt: bot.lastMessage?.createdAt ?? null,
		preview: preview.text.length > PREVIEW_MAX_CHARS ? `${preview.text.slice(0, PREVIEW_MAX_CHARS)}…` : preview.text,
		previewSent: preview.sent,
	};
}

/** Texto de busca de cada bot (nome e prévia, sem acento nem caixa), calculado uma vez por retrato. */
export function buildSearchIndex(bots: readonly HomeBot[]): ReadonlyMap<string, string> {
	return new Map(bots.map((bot) => [bot.id, foldText(`${bot.name} ${bot.preview}`)]));
}

/**
 * Divide os bots em fixados (por `pinOrder`) e seções (na ordem de `order`), mantendo a ordem do servidor
 * dentro de cada seção. A busca filtra por nome e prévia; durante ela as seções vazias somem, e sem busca uma
 * seção vazia continua à mostra (o web mostra "sem conversas").
 */
export function buildHome(bots: readonly HomeBot[], sections: readonly SectionRef[], query = "", index?: ReadonlyMap<string, string>): HomeLayout {
	const term = foldText(query);
	const texts = term ? (index ?? buildSearchIndex(bots)) : null;
	const visible = texts ? bots.filter((bot) => texts.get(bot.id)?.includes(term)) : [...bots];
	const pinned = visible
		.filter((bot) => bot.pinned)
		.map((bot, index) => ({ bot, index }))
		.sort((a, b) => (a.bot.pinOrder ?? 0) - (b.bot.pinOrder ?? 0) || a.index - b.index)
		.map((item) => item.bot);
	const rest = visible.filter((bot) => !bot.pinned);
	const ordered = [...sections].sort((a, b) => a.order - b.order);
	const known = new Set(ordered.map((section) => section.id));
	const result: HomeSection[] = ordered.map((section) => ({
		key: section.id,
		title: section.name,
		bots: rest.filter((bot) => bot.sectionId === section.id),
	}));
	const loose = rest.filter((bot) => !bot.sectionId || !known.has(bot.sectionId));
	if (loose.length > 0) result.push({ key: NO_SECTION_KEY, title: NO_SECTION_TITLE, bots: loose });
	return { pinned, sections: term ? result.filter((section) => section.bots.length > 0) : result };
}

const MONTHS = ["jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const DAY_MS = 86_400_000;

const pad = (value: number) => String(value).padStart(2, "0");
const dayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;

/**
 * Data da última mensagem na linha (horário local, `now` injetado): "agora" (menos de 1 min), "14:05" (hoje),
 * "Ontem", "Seg" (até 6 dias), "5 de out." (neste ano) e "5 de out. de 2025" (antes). Vazio se não houver data.
 */
export function formatListDate(iso: string | null | undefined, now: Date): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return "";
	if (Math.abs(now.getTime() - date.getTime()) < 60_000) return "agora";
	const diff = dayNumber(now) - dayNumber(date);
	if (diff <= 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (diff === 1) return "Ontem";
	if (diff <= 6) return WEEKDAYS[date.getDay()] ?? "";
	const label = `${date.getDate()} de ${MONTHS[date.getMonth()]}`;
	return date.getFullYear() === now.getFullYear() ? label : `${label} de ${date.getFullYear()}`;
}

/** Iniciais para o avatar da conta sem foto: duas letras do nome, ou a inicial do e-mail. */
export function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
	const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return (email ?? "?").trim().charAt(0).toUpperCase() || "?";
}
