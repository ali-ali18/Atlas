// Protocolo da capacidade `browser` com a porta `Sandbox` (F8.1). A porta só garante o canal; os `kind`s abaixo são
// DESTA capacidade e o adaptador do worker (`apps/worker/src/v4-adapters/browser-actions.ts`) os leva ao control server
// da VM (`docker/agent-sandbox/control/browser-v4.mjs`). Os três lados falam o mesmo formato, validado aqui por zod.
//
// Decisão do dono (05/11): ver a página inteira, nunca enxugar escondido. Por isso a leitura é em TRÊS camadas:
//   1. `browser.map`   estrutura da página e o tamanho de cada lista (nunca a lista inteira);
//   2. `browser.read`  uma parte de uma seção ("de 201 a 250"), dizendo onde está e quanto falta;
//   3. `browser.find`  busca na VM: só os trechos que batem, com ref para agir.
// "Carregar mais" (`browser.load_more`) é ação explícita; volume grande vai para arquivo na VM (`browser.export`).
// Itens são numerados de 1 em diante, na ordem em que a página os tem carregados.
import { z } from "zod";

export const BROWSER_KINDS = {
	open: "browser.open",
	map: "browser.map",
	read: "browser.read",
	find: "browser.find",
	act: "browser.act",
	loadMore: "browser.load_more",
	wait: "browser.wait",
	tabs: "browser.tabs",
	screenshot: "browser.screenshot",
	export: "browser.export",
} as const;
export type BrowserKind = (typeof BROWSER_KINDS)[keyof typeof BROWSER_KINDS];
export const BROWSER_KIND_LIST: readonly BrowserKind[] = Object.values(BROWSER_KINDS);

/** Quanto cabe numa parte (janela do modelo, não economia): acima disso a parte termina antes e diz de onde seguir. */
export const PART_MAX_CHARS = 24_000;
export const READ_DEFAULT_COUNT = 50;
export const READ_MAX_COUNT = 200;
export const ITEM_DEFAULT_CHARS = 1_500;
export const ITEM_MAX_CHARS = 20_000;
export const FIND_DEFAULT_LIMIT = 20;
export const FIND_MAX_LIMIT = 100;
/** Quantas vezes seguidas uma chamada de `load_more` tenta carregar. */
export const LOAD_MORE_MAX_TIMES = 10;
/** Voltas máximas do `export` com `loadAll` (limite técnico de tempo na VM; o resultado diz se parou por ele). */
export const EXPORT_MAX_ROUNDS = 300;

export const exportIdSchema = z.string().regex(/^x[0-9a-z]{4,24}$/);
export const sectionId = z.string().regex(/^s\d{1,4}$/, 'a section id from browser_map (like "s3")');
export const refId = z.string().regex(/^(?:f\d{1,3})?[ae]\d{1,5}$/, 'a ref from browser_map/browser_read/browser_find (like "e12" or "a7")');

export const mapSectionSchema = z.object({
	id: sectionId,
	kind: z.enum(["list", "table", "text", "form", "nav"]),
	label: z.string(),
	/** Itens já carregados na página. */
	items: z.number().int().min(0),
	/** Total que a PÁGINA declara ("1.024 comentários"); `null` = a página não diz. */
	declaredTotal: z.number().int().min(0).nullable(),
	/** A seção tem como carregar mais (botão ou rolagem infinita). */
	canLoadMore: z.boolean(),
	chars: z.number().int().min(0),
	preview: z.string().optional(),
	ref: z.string().optional(),
});
export type MapSection = z.infer<typeof mapSectionSchema>;

export const openDataSchema = z.object({
	url: z.string(),
	title: z.string(),
	tabId: z.string().optional(),
	/** A VM achou um captcha ou uma parede anti-robô: não é o conteúdo real. */
	wall: z.enum(["captcha", "blocked"]).optional(),
});
export const mapDataSchema = z.object({
	url: z.string(),
	title: z.string(),
	totalChars: z.number().int().min(0),
	sections: z.array(mapSectionSchema),
	/** Seções pequenas que ficaram fora do mapa por passar do limite (dito, nunca em silêncio). */
	omittedSections: z.number().int().min(1).optional(),
	/** A árvore de acessibilidade quase não tem nome nos controles (ícones, canvas): vale uma captura de tela. */
	poorTree: z.boolean().optional(),
	wall: z.enum(["captcha", "blocked"]).optional(),
});
export type MapData = z.infer<typeof mapDataSchema>;

export const readItemSchema = z.object({
	n: z.number().int().min(1),
	text: z.string(),
	/** Caracteres que ficaram de fora DESTE item por causa de `itemChars` (nunca em silêncio). */
	clippedChars: z.number().int().min(1).optional(),
	refs: z.array(z.object({ ref: z.string(), name: z.string() })).optional(),
});
export const readDataSchema = z.object({
	section: sectionId,
	label: z.string(),
	from: z.number().int().min(1),
	/** Último item devolvido (0 quando a seção está vazia). */
	to: z.number().int().min(0),
	loaded: z.number().int().min(0),
	declaredTotal: z.number().int().min(0).nullable(),
	canLoadMore: z.boolean(),
	/** De onde seguir no que já está carregado; `null` = acabou o carregado. */
	nextFrom: z.number().int().min(1).nullable(),
	items: z.array(readItemSchema),
});
export type ReadData = z.infer<typeof readDataSchema>;

export const findDataSchema = z.object({
	section: sectionId.optional(),
	searchedItems: z.number().int().min(0),
	totalMatches: z.number().int().min(0),
	matches: z.array(z.object({ section: sectionId, n: z.number().int().min(1), snippet: z.string(), ref: z.string().optional() })),
});

export const actDataSchema = z.object({
	url: z.string(),
	title: z.string(),
	/** O que mudou na página depois da ação (texto curto da VM). */
	changes: z.string().optional(),
	/** A página quer a pessoa: senha, código, captcha. */
	needsOwner: z.enum(["password", "code", "captcha"]).optional(),
});

export const loadMoreDataSchema = z.object({
	section: sectionId,
	before: z.number().int().min(0),
	after: z.number().int().min(0),
	declaredTotal: z.number().int().min(0).nullable(),
	method: z.enum(["button", "scroll"]),
	/** Nada novo apareceu: a página não tem mais (ou não respondeu). */
	reachedEnd: z.boolean(),
});

export const waitDataSchema = z.object({ url: z.string(), met: z.boolean(), waitedMs: z.number().int().min(0) });
/** `id` é o número da aba na lista (1, 2, ...), o mesmo que `switch` e `close` pedem. */
export const tabsDataSchema = z.object({ tabs: z.array(z.object({ id: z.string(), url: z.string(), title: z.string(), active: z.boolean() })) });
export const screenshotDataSchema = z.object({ mediaType: z.string(), data: z.string(), width: z.number().int(), height: z.number().int() });
export const exportDataSchema = z.object({
	exportId: exportIdSchema,
	/** Caminho do arquivo na VM (pasta de trabalho do dono). */
	path: z.string(),
	section: sectionId,
	items: z.number().int().min(0),
	chars: z.number().int().min(0),
	declaredTotal: z.number().int().min(0).nullable(),
	/** Por que parou de carregar: `end` (acabou), `limit` (voltas máximas), `stalled` (a página não deu mais). */
	stoppedBy: z.enum(["not_requested", "end", "limit", "stalled"]),
});
export type ExportData = z.infer<typeof exportDataSchema>;

/** Prefixo do erro da VM quando a ação submete algo e o modelo a declarou `browse`. A tool o reescreve com a dica. */
export const SUBMIT_INTENT_REQUIRED = "SUBMIT_INTENT_REQUIRED";
export const ACT_ACTIONS = ["click", "type", "select", "check", "uncheck", "hover", "press", "clear"] as const;
export const ACT_INTENTS = ["browse", "submit"] as const;
