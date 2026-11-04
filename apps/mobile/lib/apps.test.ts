import { describe, expect, it } from "vitest";
import { appRouteParams, composioDisplayName, composioLogoForSlug, isSvgUri, resolveIconUri, type AppsRow, buildAppsRows, buildChips, composioAction, composioCategoryOf, composioWantsMore, connectedCountText, connectedItems, customAction, initialOf, isFeatured, mergeToolkits, nativeAction, appRefId, parseAppRef, type SectionsInput } from "./apps";
import type { ComposioToolkit, NativeConnector } from "./apps-parse";
import { MAX_COMPOSIO_CATEGORIES } from "./apps-parse";
import { applyPage, EMPTY_PAGING, MAX_ITEMS } from "./composio-paging";
import type { CatalogBot } from "./catalog";

const native = (over: Partial<NativeConnector> & { id: string }): NativeConnector => ({ name: over.id.toUpperCase(), description: `desc ${over.id}`, longDescription: "", category: "productivity", icon: null, authType: "oauth", comingSoon: false, apiKey: null, skills: [], oauthReady: true, connectionId: null, status: null, accountCount: 0, ...over });
const toolkit = (slug: string, over: Partial<ComposioToolkit> = {}): ComposioToolkit => ({ slug, name: slug, description: "", logo: null, connected: false, noAuth: false, nativeCatalogId: null, ...over });
const bot = (slug: string, over: Partial<CatalogBot> = {}): CatalogBot => ({ slug, name: slug, description: "", author: "", category: "geral", tags: [], skills: [], color: "red", shape: "squircle", ...over });

describe("estado do botão", () => {
	it("conectar, conectado, autorizar, em breve e indisponível", () => {
		expect(nativeAction(native({ id: "a" }))).toBe("connect");
		expect(nativeAction(native({ id: "a", status: "connected", connectionId: "1" }))).toBe("connected");
		expect(nativeAction(native({ id: "a", status: "pending_auth", connectionId: "1" }))).toBe("authorize");
		expect(nativeAction(native({ id: "a", status: "error", connectionId: "1" }))).toBe("authorize");
		expect(nativeAction(native({ id: "a", comingSoon: true, status: "connected", connectionId: "1" }))).toBe("soon");
		expect(nativeAction(native({ id: "a", oauthReady: false }))).toBe("unavailable");
	});
	it("conector de chave com conexão em erro/pendente volta a Conectar (cola a chave de novo); OAuth continua Autorizar", () => {
		const key = { id: "a", authType: "api_key" as const, oauthReady: false, apiKey: { label: "k", helpUrl: "" }, connectionId: "1" };
		expect(nativeAction(native({ ...key, status: "error" }))).toBe("connect");
		expect(nativeAction(native({ ...key, status: "pending_auth" }))).toBe("connect");
		expect(nativeAction(native({ ...key, status: "connected" }))).toBe("connected");
		expect(nativeAction(native({ id: "g", authType: "oauth", oauthReady: true, apiKey: { label: "PAT", helpUrl: "" }, status: "error", connectionId: "1" }))).toBe("authorize");
	});
	it("status pendente sem conexão conhecida volta a conectar; OAuth sem env mas com chave ainda conecta", () => {
		expect(nativeAction(native({ id: "a", status: "pending_auth" }))).toBe("connect");
		expect(nativeAction(native({ id: "a", oauthReady: false, apiKey: { label: "k", helpUrl: "" } }))).toBe("connect");
	});
	it("autenticação 'none' conecta direto", () => {
		expect(nativeAction(native({ id: "a", authType: "none", oauthReady: false }))).toBe("connect");
	});
	it("Composio e conector próprio", () => {
		expect(composioAction({ connected: true })).toBe("connected");
		expect(composioAction({ connected: false })).toBe("connect");
		expect(customAction({ status: "connected" })).toBe("connected");
		expect(customAction({ status: "error" })).toBe("authorize");
	});
});

describe("rota do detalhe", () => {
	it("vai e volta, inclusive com ':' no id", () => {
		expect(appRefId({ kind: "composio", id: "gmail" })).toBe("composio:gmail");
		expect(parseAppRef("native:google_drive")).toEqual({ kind: "native", id: "google_drive" });
		expect(parseAppRef("custom:a:b")).toEqual({ kind: "custom", id: "a:b" });
	});
	it("recusa formato inválido", () => {
		expect(parseAppRef("gmail")).toBeNull();
		expect(parseAppRef("x:gmail")).toBeNull();
		expect(parseAppRef("native:")).toBeNull();
		expect(parseAppRef(":a")).toBeNull();
	});
});

describe("destaque", () => {
	it("firecrawl, github e drive; slack só com login pronto; em breve nunca", () => {
		expect(["firecrawl", "github", "google_drive", "notion"].map((id) => isFeatured(native({ id })))).toEqual([true, true, true, false]);
		expect(isFeatured(native({ id: "slack", oauthReady: false }))).toBe(false);
		expect(isFeatured(native({ id: "slack", oauthReady: true }))).toBe(true);
		expect(isFeatured(native({ id: "github", comingSoon: true }))).toBe(false);
	});
});

const base = (over: Partial<SectionsInput> = {}): SectionsInput => ({
	entries: [native({ id: "firecrawl", category: "search" }), native({ id: "github", status: "connected", connectionId: "c1" }), native({ id: "notion" }), native({ id: "gmail", category: "google" })],
	connections: [{ id: "x1", catalogId: null, name: "Meu MCP", authType: "oauth", status: "connected", accountLabel: "eu" }],
	composioConnections: [{ id: "k1", toolkit: "slack_x", toolkitName: "Slack X", noAuth: false }],
	composio: { status: "ready", items: [toolkit("asana"), toolkit("trello", { connected: true }), toolkit("dup", { nativeCatalogId: "github" })], hasMore: true, loadingMore: false },
	bots: [bot("b1"), bot("b2")],
	query: "",
	chip: "",
	...over,
});
const headers = (rows: AppsRow[]) => rows.filter((row) => row.kind === "header").map((row) => (row as { label: string }).label);
const appKeys = (rows: AppsRow[]) => rows.filter((row) => row.kind === "app").map((row) => (row as { key: string }).key);

describe("buildAppsRows", () => {
	it("sem busca: conectados, destaque, categorias, bots e apps, nessa ordem, sem repetir conectado", () => {
		const rows = buildAppsRows(base());
		expect(headers(rows)).toEqual(["Conectados", "Em destaque", "Google", "Pesquisa web", "Produtividade", "Bots", "Apps"]);
		expect(appKeys(rows)).toEqual(["native:github", "custom:x1", "composio:slack_x", "f:firecrawl", "n:gmail", "n:firecrawl", "n:notion", "c:asana", "c:trello"]);
		expect(rows.some((row) => row.kind === "autoload")).toBe(true);
	});
	it("Composio: o conectado (pelas conexões do dono, não pelo item velho) e o que já é nativo ficam de fora de Apps", () => {
		expect(appKeys(buildAppsRows(base())).filter((key) => key.startsWith("c:"))).toEqual(["c:asana", "c:trello"]);
		// Recém-conectado: a lista ainda diz connected:false, mas a conexão existe => só em Conectados.
		const fresh = buildAppsRows(base({ composioConnections: [{ id: "k9", toolkit: "asana", toolkitName: "Asana", noAuth: false }] }));
		expect(appKeys(fresh)).toContain("composio:asana");
		expect(appKeys(fresh)).not.toContain("c:asana");
		// Desconectado: o item velho dizia connected:true, mas sem conexão ele volta a poder ser conectado.
		const gone = buildAppsRows(base({ composioConnections: [] }));
		expect(appKeys(gone)).toContain("c:trello");
	});
	it("o marcador de carregar ao rolar continua quando a página inteira foi filtrada mas há mais páginas", () => {
		const rows = buildAppsRows(base({ composio: { status: "ready", items: [toolkit("so-nativo", { nativeCatalogId: "github" })], hasMore: true, loadingMore: false } }));
		expect(appKeys(rows).filter((key) => key.startsWith("c:"))).toEqual([]);
		expect(rows.some((row) => row.kind === "autoload")).toBe(true);
		expect(rows.some((row) => row.kind === "more" && row.target === "composio")).toBe(false);
		const none = buildAppsRows(base({ composio: { status: "ready", items: [], hasMore: false, loadingMore: false } }));
		expect(headers(none)).not.toContain("Apps");
	});
	it("conexão do Composio com o mesmo id de um nativo NÃO conectado aparece em Conectados; com o nativo conectado, só o nativo", () => {
		const shows = connectedItems({ entries: [native({ id: "github" })], connections: [], composioConnections: [{ id: "1", toolkit: "github", toolkitName: "GitHub", noAuth: false }] });
		expect(shows.map((item) => item.key)).toEqual(["composio:github"]);
		const dedup = connectedItems({ entries: [native({ id: "github", status: "connected", connectionId: "c" })], connections: [], composioConnections: [{ id: "1", toolkit: "github", toolkitName: "GitHub", noAuth: false }] });
		expect(dedup.map((item) => item.key)).toEqual(["native:github"]);
	});
	it("chip de categoria nativa mostra só ela (e só os conectados dela)", () => {
		const rows = buildAppsRows(base({ chip: "n:search" }));
		expect(headers(rows)).toEqual(["Pesquisa web"]);
		expect(appKeys(rows)).toEqual(["n:firecrawl"]);
		const prod = buildAppsRows(base({ chip: "n:productivity" }));
		expect(headers(prod)).toEqual(["Conectados", "Produtividade"]);
		expect(appKeys(prod)).toEqual(["native:github", "n:notion"]);
	});
	it("chip Bots mostra só bots, todos (sem 'ver todos')", () => {
		const rows = buildAppsRows(base({ chip: "bots", bots: Array.from({ length: 8 }, (_, i) => bot(`b${i}`)) }));
		expect(headers(rows)).toEqual(["Bots"]);
		expect(rows.filter((row) => row.kind === "bot")).toHaveLength(8);
		expect(rows.some((row) => row.kind === "more")).toBe(false);
	});
	it("visão Todos limita os bots e oferece 'Ver todos (n)'", () => {
		const rows = buildAppsRows(base({ bots: Array.from({ length: 8 }, (_, i) => bot(`b${i}`)) }));
		expect(rows.filter((row) => row.kind === "bot")).toHaveLength(5);
		expect(rows.find((row) => row.kind === "more" && row.target === "bots")).toMatchObject({ label: "Ver todos (8)" });
	});
	it("categoria do Composio mostra só os apps", () => {
		const rows = buildAppsRows(base({ chip: "c:crm" }));
		expect(headers(rows)).toEqual(["Conectados", "Apps"]);
		expect(appKeys(rows)).toEqual(["composio:slack_x", "c:asana", "c:trello"]);
	});
	it("busca filtra nativos, conectados e bots no cliente, sem destaque nem categorias", () => {
		const rows = buildAppsRows(base({ query: "GIT", composio: { status: "ready", items: [], hasMore: false, loadingMore: false }, bots: [bot("b1", { name: "Gitbot" }), bot("b2")] }));
		expect(headers(rows)).toEqual(["Conectados", "Bots"]);
		expect(appKeys(rows)).toEqual(["native:github"]);
		expect(rows.filter((row) => row.kind === "bot")).toHaveLength(1);
	});
	it("busca sem acento e por descrição", () => {
		const rows = buildAppsRows(base({ query: "desc notion", composio: { status: "ready", items: [], hasMore: false, loadingMore: false }, bots: [] }));
		expect(appKeys(rows)).toEqual(["n:notion"]);
	});
	it("sem resultado: estado vazio com o texto buscado", () => {
		const rows = buildAppsRows(base({ query: "zzz", composio: { status: "ready", items: [], hasMore: false, loadingMore: false }, bots: [] }));
		expect(rows).toEqual([{ kind: "empty", key: "empty", text: "Nada encontrado para “zzz”." }]);
	});
	it("Composio desligado: aviso simples e nada de campo de chave; carregando não vira vazio", () => {
		const off = buildAppsRows(base({ composio: { status: "off" } }));
		expect(off.find((row) => row.kind === "note")).toMatchObject({ text: "Ative os apps nas Configurações do site." });
		const loading = buildAppsRows(base({ entries: [], connections: [], composioConnections: [], bots: null, composio: { status: "loading" } }));
		expect(loading).toEqual([]);
	});
	it("Composio com erro mostra aviso com nova tentativa; o fim da lista mostra o carregando da próxima página", () => {
		expect(buildAppsRows(base({ composio: { status: "error" } })).find((row) => row.kind === "note")).toMatchObject({ retry: true });
		const more = buildAppsRows(base({ composio: { status: "ready", items: [toolkit("a")], hasMore: true, loadingMore: true } })).find((row) => row.kind === "autoload");
		expect(more).toMatchObject({ loading: true });
	});
	it("bots vêm antes dos apps do Composio (a lista do Composio cresce ao rolar)", () => {
		const rows = buildAppsRows(base({ composio: { status: "ready", items: [toolkit("a")], hasMore: true, loadingMore: false } }));
		const labels = headers(rows);
		if (labels.includes("Bots")) expect(labels.indexOf("Bots")).toBeLessThan(labels.indexOf("Apps"));
		expect(rows.at(-1)?.kind).toBe("autoload");
	});
	it("só pede a próxima página do Composio quando há mais e nenhuma está a caminho", () => {
		expect(composioWantsMore({ status: "ready", items: [], hasMore: true, loadingMore: false })).toBe(true);
		expect(composioWantsMore({ status: "ready", items: [], hasMore: true, loadingMore: true })).toBe(false);
		expect(composioWantsMore({ status: "ready", items: [], hasMore: false, loadingMore: false })).toBe(false);
		expect(composioWantsMore({ status: "loading" })).toBe(false);
	});
	it("não repete o app do Composio que é nativo nas conexões", () => {
		const items = connectedItems({ entries: [native({ id: "github", status: "connected", connectionId: "c" })], connections: [], composioConnections: [{ id: "1", toolkit: "github", toolkitName: "GitHub", noAuth: false }, { id: "2", toolkit: "x", toolkitName: "X", noAuth: false }, { id: "3", toolkit: "x", toolkitName: "X", noAuth: false }], composioLogos: new Map([["x", "https://l/x.png"]]) });
		expect(items.map((item) => [item.key, item.icon])).toEqual([["native:github", null], ["composio:x", "https://l/x.png"]]);
	});
});

describe("chips", () => {
	it("categorias nativas em ordem alfabética (sem 'custom'), Bots e as do Composio", () => {
		const chips = buildChips([native({ id: "a", category: "search" }), native({ id: "b", category: "google" }), native({ id: "c", category: "custom" }), native({ id: "d", category: "search" })], [{ id: "crm", name: "CRM" }]);
		expect(chips.map((chip) => chip.id)).toEqual(["n:google", "n:search", "bots", "c:crm"]);
		expect(chips.map((chip) => chip.label)).toEqual(["Google", "Pesquisa web", "Bots", "CRM"]);
	});
	it("composioCategoryOf", () => {
		expect(composioCategoryOf("c:crm")).toBe("crm");
		expect(composioCategoryOf("n:search")).toBeNull();
		expect(composioCategoryOf("c:")).toBeNull();
	});
});

describe("ícone e parâmetros da rota", () => {
	it("caminho do app vira URL do servidor; https passa; o resto cai na inicial", () => {
		expect(resolveIconUri("/connectors/github.svg", "https://api.exemplo.com/base")).toBe("https://api.exemplo.com/connectors/github.svg");
		expect(resolveIconUri("/connectors/github.svg", null)).toBeNull();
		expect(resolveIconUri("https://logos.x/a.png", null)).toBe("https://logos.x/a.png");
		expect(resolveIconUri("http://logos.x/a.png", null)).toBeNull();
		expect(resolveIconUri("//evil.com/a.svg", "https://api.exemplo.com")).toBeNull();
		expect(resolveIconUri("/../etc/x.svg", "https://api.exemplo.com")).toBeNull();
		expect(resolveIconUri("javascript:alert(1)", null)).toBeNull();
		expect(resolveIconUri(null, "https://api.exemplo.com")).toBeNull();
	});
	it("isSvgUri olha o caminho, não a query", () => {
		expect(isSvgUri("https://x/a.SVG")).toBe(true);
		expect(isSvgUri("https://x/a.png?f=.svg")).toBe(false);
	});
	it("só o app do Composio leva nome, texto e logo na rota", () => {
		expect(appRouteParams({ ref: { kind: "native", id: "github" }, name: "GitHub", description: "d", icon: "/c.svg" })).toEqual({ id: "native:github" });
		expect(appRouteParams({ ref: { kind: "composio", id: "asana" }, name: "Asana", description: "", icon: null })).toEqual({ id: "composio:asana", name: "Asana" });
		expect(appRouteParams({ ref: { kind: "composio", id: "asana" }, name: "Asana", description: "Tarefas", icon: "https://l/a.png" })).toEqual({ id: "composio:asana", name: "Asana", description: "Tarefas", logo: "https://l/a.png" });
	});
});

describe("pequenos auxiliares", () => {
	it("contagem no singular e no plural", () => {
		expect(connectedCountText(1)).toBe("1 conectado");
		expect(connectedCountText(3)).toBe("3 conectados");
	});
	it("inicial do ícone", () => {
		expect(initialOf("  éter")).toBe("É");
		expect(initialOf("")).toBe("?");
		expect(initialOf("!!!")).toBe("?");
	});
	it("mergeToolkits não repete app", () => {
		expect(mergeToolkits([toolkit("a"), toolkit("b")], [toolkit("b"), toolkit("c")]).map((item) => item.slug)).toEqual(["a", "b", "c"]);
	});
});

describe("chegada de uma página enorme do Composio (servidor que ignora limit=20)", () => {
	it("1700 itens viram poucas linhas e o trabalho da tela não cresce com o catálogo", () => {
		const huge = { items: Array.from({ length: 1700 }, (_, index) => toolkit(`app-${index}`)), nextCursor: "c1", totalItems: 1700 };
		const started = performance.now();
		const paging = applyPage(EMPTY_PAGING, huge, null);
		const rows = buildAppsRows(base({ composio: { status: "ready", items: paging.items, hasMore: !paging.done, loadingMore: false } }));
		const elapsed = performance.now() - started;
		expect(paging.items.length).toBeLessThanOrEqual(MAX_ITEMS);
		expect(appKeys(rows).filter((key) => key.startsWith("c:")).length).toBeLessThanOrEqual(MAX_ITEMS);
		expect(rows.length).toBeLessThan(MAX_ITEMS + 40);
		expect(elapsed).toBeLessThan(200);
	});
});

describe("buildChips com muitas categorias do Composio", () => {
	it("nunca passa do teto de categorias do Composio", () => {
		const many = Array.from({ length: 63_508 }, (_, i) => ({ id: `c${i}`, name: `Cat ${i}` }));
		const chips = buildChips([], many);
		const composioChips = chips.filter((chip) => composioCategoryOf(chip.id) !== null);
		expect(composioChips).toHaveLength(MAX_COMPOSIO_CATEGORIES);
		expect(composioChips[0]!.label).toBe("Cat 0");
		expect(composioCategoryOf(composioChips[0]!.id)).toBe("c0");
	});
});

describe("logo e nome de conexão do Composio", () => {
	const connection = (toolkit: string, toolkitName: string) => ({ id: toolkit, toolkit, toolkitName, noAuth: false });
	it("deriva o logo do slug quando o mapa não tem", () => {
		expect(composioLogoForSlug("googledocs")).toBe("https://logos.composio.dev/api/googledocs");
		expect(composioLogoForSlug("Google_Drive")).toBe("https://logos.composio.dev/api/google_drive");
		expect(composioLogoForSlug("../x")).toBeNull();
		expect(composioLogoForSlug("a b")).toBeNull();
		expect(composioLogoForSlug("")).toBeNull();
	});
	it("separa marca composta e restaura a caixa", () => {
		expect(composioDisplayName("googledocs", "Googledocs")).toBe("Google Docs");
		expect(composioDisplayName("googlecalendar", "Googlecalendar")).toBe("Google Calendar");
		expect(composioDisplayName("github", "Github")).toBe("GitHub");
		expect(composioDisplayName("browser_tool", "Browser tool")).toBe("Browser Tool");
		expect(composioDisplayName("linear", "Linear")).toBe("Linear");
		expect(composioDisplayName("googlecalendar", "Calendário")).toBe("Calendário");
	});
	it("conexão sem logo no mapa ganha o logo pelo slug; o do mapa tem prioridade", () => {
		const items = connectedItems({ entries: [], connections: [], composioConnections: [connection("googledocs", "Googledocs"), connection("x", "X")], composioLogos: new Map([["x", "https://l/x.png"], ["googledocs", null]]) });
		expect(items.map((item) => [item.name, item.icon])).toEqual([["Google Docs", "https://logos.composio.dev/api/googledocs"], ["X", "https://l/x.png"]]);
	});
});
