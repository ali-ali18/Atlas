// Catálogo de bots prontos (o marketplace do web, só a parte de bots): parse das respostas de `GET /v1/catalog` e
// `GET /v1/catalog/bots/:slug`, categorias, filtro, busca e as linhas da lista. Funções puras, testadas em catalog.test.ts.
// O conteúdo do catálogo é dado não confiável: o que não tem o formato esperado é descartado, nunca desenhado.
import { BOT_PROPOSAL_DEFAULT_COLOR, BOT_PROPOSAL_DEFAULT_SHAPE, isBotProposalShape, resolveBotProposalColor } from "@workspace/shared";

export type CatalogBot = { slug: string; name: string; description: string; author: string; category: string; tags: string[]; skills: string[]; color: string; shape: string };
export type CatalogSkill = { slug: string; name: string; description: string; blocked: boolean };
/** `index` é a posição da rotina na lista do servidor: é ela que vai em `routines` no install (descartar uma inválida não pode deslocar as outras). */
export type CatalogRoutine = { index: number; name: string; prompt: string; cron: string };
export type CatalogDetail = {
	slug: string;
	name: string;
	description: string;
	color: string;
	shape: string;
	suggestedModel: string | null;
	skills: CatalogSkill[];
	routines: CatalogRoutine[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const textList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []);

function parseBot(raw: unknown): CatalogBot | null {
	if (!isRecord(raw)) return null;
	const slug = text(raw.slug);
	const name = text(raw.name);
	if (!slug || !name) return null;
	return {
		slug,
		name,
		description: text(raw.description),
		author: text(raw.author),
		category: text(raw.category) || "geral",
		tags: textList(raw.tags),
		skills: textList(raw.skills),
		color: resolveBotProposalColor(raw.color) ?? BOT_PROPOSAL_DEFAULT_COLOR,
		shape: isBotProposalShape(raw.shape) ? raw.shape.trim() : BOT_PROPOSAL_DEFAULT_SHAPE,
	};
}

/** Os bots do catálogo; entrada sem slug ou nome é descartada, e corpo que não é um catálogo dá `null`. */
export function parseCatalog(body: unknown): CatalogBot[] | null {
	if (!isRecord(body) || !Array.isArray(body.bots)) return null;
	const seen = new Set<string>();
	const bots: CatalogBot[] = [];
	for (const raw of body.bots) {
		const bot = parseBot(raw);
		if (!bot || seen.has(bot.slug)) continue;
		seen.add(bot.slug);
		bots.push(bot);
	}
	return bots;
}

/** O detalhe de um bot; sem o modelo do bot (nome e slug) a resposta é inútil e dá `null`. */
export function parseCatalogDetail(body: unknown): CatalogDetail | null {
	if (!isRecord(body) || !isRecord(body.bot)) return null;
	const bot = body.bot;
	const entry = isRecord(body.entry) ? body.entry : {};
	const slug = text(bot.slug) || text(entry.slug);
	const name = text(bot.name);
	if (!slug || !name) return null;
	const skills: CatalogSkill[] = [];
	for (const raw of Array.isArray(body.skills) ? body.skills : []) {
		if (!isRecord(raw)) continue;
		const skillSlug = text(raw.slug);
		if (!skillSlug) continue;
		skills.push({ slug: skillSlug, name: text(raw.name) || skillSlug, description: text(raw.description), blocked: raw.blocked === true });
	}
	const routines: CatalogRoutine[] = [];
	(Array.isArray(bot.starterRoutines) ? bot.starterRoutines : []).forEach((raw: unknown, index: number) => {
		if (!isRecord(raw)) return;
		const routineName = text(raw.name);
		const prompt = text(raw.prompt);
		const cron = text(raw.cron);
		if (routineName && prompt && cron) routines.push({ index, name: routineName, prompt, cron });
	});
	return {
		slug,
		name,
		description: text(bot.description) || text(entry.description),
		color: resolveBotProposalColor(bot.color) ?? BOT_PROPOSAL_DEFAULT_COLOR,
		shape: isBotProposalShape(bot.shape) ? bot.shape.trim() : BOT_PROPOSAL_DEFAULT_SHAPE,
		suggestedModel: text(bot.suggestedModel) || null,
		skills,
		routines,
	};
}

// ---- categorias, filtro e busca ------------------------------------------------------------------------------------

/** Os mesmos rótulos do web (`marketplace.category.*`, pt-BR). */
const CATEGORY_LABELS: Record<string, string> = { games: "Jogos", dev: "Desenvolvimento", productivity: "Produtividade", research: "Pesquisa", writing: "Escrita", data: "Dados", geral: "Geral" };

export function categoryLabel(id: string): string {
	if (Object.hasOwn(CATEGORY_LABELS, id)) return CATEGORY_LABELS[id]!;
	const label = id.replace(/-/g, " ").trim();
	return label ? label[0]!.toUpperCase() + label.slice(1) : "Geral";
}

export type CategoryOption = { id: string; label: string; count: number };

/** Categorias presentes no catálogo, em ordem alfabética do rótulo (como no web). */
export function categoriesOf(bots: readonly CatalogBot[]): CategoryOption[] {
	const counts = new Map<string, number>();
	for (const bot of bots) counts.set(bot.category, (counts.get(bot.category) ?? 0) + 1);
	return [...counts.entries()].map(([id, count]) => ({ id, label: categoryLabel(id), count })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/** Sem acento e em minúsculas ("Conversão" casa com "conversao"). */
export function plain(value: string): string {
	return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function haystack(bot: CatalogBot): string {
	return plain([bot.name, bot.description, bot.author, bot.tags.join(" "), categoryLabel(bot.category), bot.skills.join(" ").replace(/-/g, " ")].join(" "));
}

/** Categoria ("" = todas) e busca: cada palavra digitada precisa aparecer em algum lugar do bot (nome, descrição, autor, etiquetas, categoria, habilidades). */
export function filterCatalog(bots: readonly CatalogBot[], query: string, category: string): CatalogBot[] {
	const words = plain(query).split(/\s+/).filter(Boolean);
	return bots.filter((bot) => {
		if (category && bot.category !== category) return false;
		if (words.length === 0) return true;
		const content = haystack(bot);
		return words.every((word) => content.includes(word));
	});
}

export type CatalogRow = { kind: "header"; key: string; category: string; label: string; total: number } | { kind: "bot"; key: string; bot: CatalogBot };

/** Quantos bots cada seção mostra na visão "Todos" (o resto fica atrás da seta do título). */
export const SECTION_PREVIEW = 6;

/**
 * As linhas da lista. "Todos" e sem busca: uma seção por categoria (título com seta, até `SECTION_PREVIEW` bots);
 * com categoria escolhida ou texto na busca: lista plana dos resultados.
 */
export function buildCatalogRows(bots: readonly CatalogBot[], query: string, category: string): CatalogRow[] {
	const shown = filterCatalog(bots, query, category);
	if (category || query.trim()) return shown.map((bot) => ({ kind: "bot", key: bot.slug, bot }));
	const rows: CatalogRow[] = [];
	for (const option of categoriesOf(shown)) {
		const inside = shown.filter((bot) => bot.category === option.id);
		rows.push({ kind: "header", key: `h:${option.id}`, category: option.id, label: option.label, total: inside.length });
		for (const bot of inside.slice(0, SECTION_PREVIEW)) rows.push({ kind: "bot", key: bot.slug, bot });
	}
	return rows;
}
