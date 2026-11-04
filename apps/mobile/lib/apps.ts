// Tela "Aplicativos": estado do botão, rota do detalhe, chips de categoria e a montagem das seções (conectados, destaque,
// nativos por categoria, apps do Composio e bots). Funções puras, testadas em apps.test.ts.
import { MAX_COMPOSIO_CATEGORIES, type ComposioCategory, type ComposioConnection, type ComposioToolkit, type McpConnection, type NativeConnector } from "./apps-parse";
import { type CatalogBot, filterCatalog, plain } from "./catalog";

// ---- estado do botão -----------------------------------------------------------------------------------------------

/** O que o botão da linha e do detalhe faz/mostra. `soon` e `unavailable` ficam desabilitados. */
export type AppAction = "connect" | "authorize" | "connected" | "soon" | "unavailable";

export const ACTION_LABEL: Record<AppAction, string> = { connect: "Conectar", authorize: "Autorizar", connected: "Conectado", soon: "Em breve", unavailable: "Indisponível" };

/** Precisa de uma chave colada pela pessoa (conector de chave, ou OAuth sem env no servidor que aceita chave). */
export function needsApiKey(entry: NativeConnector): boolean {
	if (!entry.apiKey) return false;
	return entry.authType === "api_key" || !entry.oauthReady;
}

export function nativeAction(entry: NativeConnector): AppAction {
	if (entry.comingSoon) return "soon";
	if (entry.status === "connected") return "connected";
	// Conexão pendente ou com erro: entrar de novo (reauth). Conector de chave não tem login: ali o caminho é colar a chave
	// de novo ("Conectar"; o servidor atualiza a conexão existente em vez de criar outra).
	if ((entry.status === "pending_auth" || entry.status === "error") && entry.connectionId && !needsApiKey(entry)) return "authorize";
	if (entry.authType === "oauth" && !entry.oauthReady && !entry.apiKey) return "unavailable";
	return "connect";
}

export function composioAction(toolkit: Pick<ComposioToolkit, "connected">): AppAction {
	return toolkit.connected ? "connected" : "connect";
}

export function customAction(connection: Pick<McpConnection, "status">): AppAction {
	return connection.status === "connected" ? "connected" : "authorize";
}

// ---- rota do detalhe -----------------------------------------------------------------------------------------------

export type AppRef = { kind: "native" | "composio" | "custom"; id: string };

/** O id da rota `apps/[id]`: `native:<id>`, `composio:<slug>` ou `custom:<connectionId>`. */
export function appRefId(ref: AppRef): string {
	return `${ref.kind}:${ref.id}`;
}

export function parseAppRef(value: string): AppRef | null {
	const at = value.indexOf(":");
	if (at <= 0) return null;
	const kind = value.slice(0, at);
	const id = value.slice(at + 1);
	if (!id || (kind !== "native" && kind !== "composio" && kind !== "custom")) return null;
	return { kind, id };
}

/** Parâmetros da rota do detalhe. App do Composio não tem endpoint de detalhe: nome, texto e logo seguem pela rota. */
export function appRouteParams(item: { ref: AppRef; name: string; description: string; icon: string | null }): Record<string, string> {
	const params: Record<string, string> = { id: appRefId(item.ref) };
	if (item.ref.kind !== "composio") return params;
	params.name = item.name;
	if (item.description) params.description = item.description;
	if (item.icon) params.logo = item.icon;
	return params;
}

// ---- categorias ----------------------------------------------------------------------------------------------------

const NATIVE_CATEGORY_LABELS: Record<string, string> = { search: "Pesquisa web", google: "Google", productivity: "Produtividade", creative: "Criação", data: "Fontes de dados", custom: "Personalizado" };

export function nativeCategoryLabel(id: string): string {
	if (Object.hasOwn(NATIVE_CATEGORY_LABELS, id)) return NATIVE_CATEGORY_LABELS[id]!;
	const label = id.replace(/-/g, " ").trim();
	return label ? label[0]!.toUpperCase() + label.slice(1) : "Outros";
}

export const BOTS_CHIP = "bots";
const NATIVE_PREFIX = "n:";
const COMPOSIO_PREFIX = "c:";

export type Chip = { id: string; label: string };

/** Chips: categorias dos nativos (as que existem), "Bots" e as categorias do Composio (quando ativo). O "Todos" é do componente. */
export function buildChips(entries: readonly NativeConnector[], composio: readonly ComposioCategory[]): Chip[] {
	const natives = [...new Set(entries.filter((entry) => entry.category !== "custom").map((entry) => entry.category))].map((id) => ({ id: NATIVE_PREFIX + id, label: nativeCategoryLabel(id) })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
	return [...natives, { id: BOTS_CHIP, label: "Bots" }, ...composio.slice(0, MAX_COMPOSIO_CATEGORIES).map((item) => ({ id: COMPOSIO_PREFIX + item.id, label: item.name }))];
}

/** A categoria do Composio escolhida (vai em `?category=`), ou `null`. */
export function composioCategoryOf(chip: string): string | null {
	return chip.startsWith(COMPOSIO_PREFIX) ? chip.slice(COMPOSIO_PREFIX.length) || null : null;
}

// ---- itens e seções ------------------------------------------------------------------------------------------------

/** Uma linha de aplicativo (nativo, próprio ou do Composio). `icon`: caminho do app (`/connectors/x.svg`) ou URL https. */
export type AppItem = { key: string; ref: AppRef; name: string; description: string; icon: string | null; action: AppAction };

export type ComposioState = { status: "loading" } | { status: "off" } | { status: "error" } | { status: "ready"; items: readonly ComposioToolkit[]; hasMore: boolean; loadingMore: boolean };

export type AppsRow =
	| { kind: "header"; key: string; label: string }
	| { kind: "app"; key: string; item: AppItem }
	| { kind: "bot"; key: string; bot: CatalogBot }
	| { kind: "note"; key: string; text: string; retry?: boolean }
	| { kind: "more"; key: string; label: string; loading: boolean; target: "composio" | "bots" }
	/** Fim da lista do Composio com mais páginas: a próxima carrega sozinha ao rolar até aqui (spinner enquanto chega). */
	| { kind: "autoload"; key: string; loading: boolean }
	| { kind: "empty"; key: string; text: string };

export const FEATURED_IDS = ["firecrawl", "github", "google_drive", "slack"] as const;
/** Quantos bots a visão "Todos" mostra antes do "Ver todos". */
export const BOTS_PREVIEW = 5;

/** Mesma regra do web: disponíveis, e o Slack só quando o login dele está configurado no servidor. */
export function isFeatured(entry: NativeConnector): boolean {
	if (entry.comingSoon) return false;
	if (entry.id === "slack") return entry.oauthReady;
	return FEATURED_IDS.includes(entry.id as (typeof FEATURED_IDS)[number]);
}

export function nativeItem(entry: NativeConnector): AppItem {
	return { key: `native:${entry.id}`, ref: { kind: "native", id: entry.id }, name: entry.name, description: entry.description, icon: entry.icon, action: nativeAction(entry) };
}

/** `connected` vem das conexões do dono (sempre frescas), não do item da lista, que pode estar velho. */
export function composioItem(toolkit: ComposioToolkit, connected = false): AppItem {
	return { key: `composio:${toolkit.slug}`, ref: { kind: "composio", id: toolkit.slug }, name: toolkit.name, description: toolkit.description, icon: toolkit.logo, action: composioAction({ connected }) };
}

/** Os conectados: nativos com conexão ativa, conectores próprios ativos e apps do Composio (com o logo da lista, se ela o trouxe). */
export function connectedItems(input: { entries: readonly NativeConnector[]; connections: readonly McpConnection[]; composioConnections: readonly ComposioConnection[]; composioLogos?: ReadonlyMap<string, string | null> }): AppItem[] {
	const items: AppItem[] = input.entries.filter((entry) => entry.status === "connected").map(nativeItem);
	for (const connection of input.connections) {
		if (connection.catalogId !== null || connection.status !== "connected") continue;
		items.push({ key: `custom:${connection.id}`, ref: { kind: "custom", id: connection.id }, name: connection.name, description: connection.accountLabel, icon: null, action: "connected" });
	}
	// Já aparece como nativo só se o nativo está conectado; senão a conexão do Composio é a única linha dele.
	const nativeSlugs = new Set(input.entries.filter((entry) => entry.status === "connected").map((entry) => entry.id));
	const seen = new Set<string>();
	for (const connection of input.composioConnections) {
		// Um app do Composio que também é nativo (ex.: GitHub) já aparece como o nativo; duas contas do mesmo app, uma linha.
		if (nativeSlugs.has(connection.toolkit) || seen.has(connection.toolkit)) continue;
		seen.add(connection.toolkit);
		items.push({ key: `composio:${connection.toolkit}`, ref: { kind: "composio", id: connection.toolkit }, name: connection.toolkitName, description: "", icon: input.composioLogos?.get(connection.toolkit) ?? null, action: "connected" });
	}
	return items;
}

function matches(item: { name: string; description: string }, words: readonly string[]): boolean {
	if (words.length === 0) return true;
	const content = plain(`${item.name} ${item.description}`);
	return words.every((word) => content.includes(word));
}

export type SectionsInput = {
	entries: readonly NativeConnector[];
	connections: readonly McpConnection[];
	composioConnections: readonly ComposioConnection[];
	composioLogos?: ReadonlyMap<string, string | null>;
	composio: ComposioState;
	bots: readonly CatalogBot[] | null;
	query: string;
	chip: string;
};

/**
 * As linhas da tela, de cima para baixo. Sem busca e sem chip: Conectados, Em destaque, nativos por categoria, Apps
 * (Composio) e Bots. Um chip de categoria de nativo mostra só aquela categoria; "Bots" só os bots; categoria do
 * Composio só os apps. Com busca, os nativos/conectados/bots são filtrados aqui (o Composio vem filtrado do servidor).
 * Quem já está em "Conectados" não se repete nas outras seções.
 */
/** A lista do Composio tem mais páginas para puxar quando a rolagem chegar ao fim (e nenhuma está a caminho). */
export function composioWantsMore(state: ComposioState): boolean {
	return state.status === "ready" && state.hasMore && !state.loadingMore;
}

export function buildAppsRows(input: SectionsInput): AppsRow[] {
	const words = plain(input.query).split(/\s+/).filter(Boolean);
	const searching = words.length > 0;
	const chip = input.chip;
	const nativeCategory = chip.startsWith(NATIVE_PREFIX) ? chip.slice(NATIVE_PREFIX.length) : null;
	const showNatives = chip === "" || nativeCategory !== null;
	const showComposio = chip === "" || composioCategoryOf(chip) !== null;
	const showBots = chip === "" || chip === BOTS_CHIP;
	const rows: AppsRow[] = [];

	const connected = showNatives || showComposio ? connectedItems(input).filter((item) => matches(item, words)) : [];
	const connectedNative = new Set(connected.filter((item) => item.ref.kind === "native").map((item) => item.ref.id));
	const visibleConnected = connected.filter((item) => {
		if (item.ref.kind === "composio") return showComposio;
		if (item.ref.kind === "native" && nativeCategory !== null) return input.entries.find((entry) => entry.id === item.ref.id)?.category === nativeCategory;
		// Conector próprio não tem categoria: só na visão geral.
		if (item.ref.kind === "custom") return chip === "";
		return showNatives;
	});
	if (visibleConnected.length > 0) {
		rows.push({ kind: "header", key: "h:connected", label: "Conectados" });
		for (const item of visibleConnected) rows.push({ kind: "app", key: item.key, item });
	}

	if (showNatives) {
		const pool = input.entries.filter((entry) => !connectedNative.has(entry.id) && entry.category !== "custom" && (nativeCategory === null || entry.category === nativeCategory) && matches(entry, words));
		if (chip === "" && !searching) {
			const featured = pool.filter(isFeatured);
			if (featured.length > 0) {
				rows.push({ kind: "header", key: "h:featured", label: "Em destaque" });
				for (const entry of featured) rows.push({ kind: "app", key: `f:${entry.id}`, item: nativeItem(entry) });
			}
			const categories = [...new Set(pool.map((entry) => entry.category))].sort((a, b) => nativeCategoryLabel(a).localeCompare(nativeCategoryLabel(b), "pt-BR"));
			for (const category of categories) {
				rows.push({ kind: "header", key: `h:cat:${category}`, label: nativeCategoryLabel(category) });
				for (const entry of pool.filter((item) => item.category === category)) rows.push({ kind: "app", key: `n:${entry.id}`, item: nativeItem(entry) });
			}
		} else if (pool.length > 0) {
			rows.push({ kind: "header", key: "h:apps", label: nativeCategory !== null ? nativeCategoryLabel(nativeCategory) : "Aplicativos" });
			for (const entry of pool) rows.push({ kind: "app", key: `n:${entry.id}`, item: nativeItem(entry) });
		}
	}

	// Bots antes dos apps do Composio: a lista do Composio cresce sem fim ao rolar e esconderia os bots no final.
	if (showBots && input.bots) {
		const filtered = filterCatalog(input.bots, input.query, "");
		if (filtered.length > 0) {
			rows.push({ kind: "header", key: "h:bots", label: "Bots" });
			const preview = chip === "" && !searching ? filtered.slice(0, BOTS_PREVIEW) : filtered;
			for (const bot of preview) rows.push({ kind: "bot", key: `b:${bot.slug}`, bot });
			if (preview.length < filtered.length) rows.push({ kind: "more", key: "more:bots", label: `Ver todos (${filtered.length})`, loading: false, target: "bots" });
		}
	}

	if (showComposio) {
		const state = input.composio;
		const label = "Apps";
		if (state.status === "off") {
			if (chip === "") {
				rows.push({ kind: "header", key: "h:composio", label });
				rows.push({ kind: "note", key: "note:off", text: "Ative os apps nas Configurações do site." });
			}
		} else if (state.status === "error") {
			rows.push({ kind: "header", key: "h:composio", label });
			rows.push({ kind: "note", key: "note:error", text: "Não consegui carregar os apps agora.", retry: true });
		} else if (state.status === "ready") {
			// Conectados (pelas conexões do dono) vão para "Conectados"; os que também são nativos aparecem como nativos.
			const connectedSlugs = new Set(input.composioConnections.map((connection) => connection.toolkit));
			const shown = state.items.filter((item) => item.nativeCatalogId === null && !connectedSlugs.has(item.slug));
			// Página toda filtrada mas com mais páginas: o marcador de fim continua (a rolagem puxa a próxima página).
			if (shown.length > 0 || state.hasMore) {
				rows.push({ kind: "header", key: "h:composio", label });
				for (const item of shown) rows.push({ kind: "app", key: `c:${item.slug}`, item: composioItem(item) });
				if (state.hasMore) rows.push({ kind: "autoload", key: "more:composio", loading: state.loadingMore });
			}
		}
	}

	if (rows.length === 0) {
		const loading = input.composio.status === "loading" && showComposio;
		if (!loading) rows.push({ kind: "empty", key: "empty", text: searching ? `Nada encontrado para “${input.query.trim()}”.` : "Nada por aqui ainda." });
	}
	return rows;
}
/** Junta a página nova sem repetir app (a paginação do servidor pode repetir na virada). */
export function mergeToolkits(current: readonly ComposioToolkit[], more: readonly ComposioToolkit[]): ComposioToolkit[] {
	const seen = new Set(current.map((item) => item.slug));
	return [...current, ...more.filter((item) => !seen.has(item.slug))];
}

/** Texto da pílula do topo: "3 conectados". */
export function connectedCountText(count: number): string {
	return `${count} ${count === 1 ? "conectado" : "conectados"}`;
}

/**
 * O endereço da imagem do ícone. Nativos trazem um caminho do app (`/connectors/x.svg`, servido pelo servidor); o
 * Composio traz uma URL https. Qualquer outra forma (esquema estranho, `..`, `//`) vira `null` e o ícone cai na inicial.
 */
export function resolveIconUri(src: string | null, serverUrl: string | null): string | null {
	if (!src) return null;
	if (/^\/(?!\/)[A-Za-z0-9._\-/]+$/.test(src) && !src.includes("..")) {
		if (!serverUrl) return null;
		try {
			return new URL(src, serverUrl).href;
		} catch {
			return null;
		}
	}
	try {
		const url = new URL(src);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

/** SVG não abre no `Image` do React Native: vai pelo `SvgUri`. */
export function isSvgUri(uri: string): boolean {
	try {
		return new URL(uri).pathname.toLowerCase().endsWith(".svg");
	} catch {
		return false;
	}
}

/** Inicial para o ícone sem imagem. */
export function initialOf(name: string): string {
	const letter = name.trim().match(/[\p{L}\p{N}]/u);
	return letter ? letter[0]!.toUpperCase() : "?";
}
