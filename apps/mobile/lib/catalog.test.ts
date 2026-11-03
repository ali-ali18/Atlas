import { describe, expect, it } from "vitest";
import { buildCatalogRows, categoriesOf, categoryLabel, filterCatalog, parseCatalog, parseCatalogDetail, SECTION_PREVIEW, type CatalogBot } from "./catalog";
import { installedSlugs, parseInstalled, recordInstall } from "./catalog-installed";

const entry = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, name: `Bot ${slug}`, description: `Descrição ${slug}`, author: "Atlas", category: "productivity", tags: [], skills: [], color: "red", shape: "blob", ...extra });

const bot = (slug: string, extra: Partial<CatalogBot> = {}): CatalogBot => ({ slug, name: slug, description: "", author: "", category: "productivity", tags: [], skills: [], color: "#FF6700", shape: "blob", ...extra });

describe("parse do catálogo", () => {
	it("resolve a cor pelo id do índice e descarta entrada sem slug ou nome e repetida", () => {
		const bots = parseCatalog({ skills: [], bots: [entry("a"), { name: "sem slug" }, entry("b", { name: "  " }), null, "x", entry("a", { name: "repetido" })] });
		expect(bots?.map((item) => item.slug)).toEqual(["a"]);
		expect(bots?.[0]?.color).toMatch(/^#[0-9a-f]{6}$/i);
		expect(bots?.[0]?.color).not.toBe("red");
	});
	it("cor e forma desconhecidas caem no padrão; categoria vazia vira geral", () => {
		const [item] = parseCatalog({ bots: [entry("a", { color: "zzz", shape: "triângulo", category: "" })] })!;
		expect(item).toMatchObject({ color: "#FF6700", shape: "blob", category: "geral" });
	});
	it("resposta que não é catálogo dá null", () => {
		for (const body of [null, "x", [], {}, { bots: "x" }, { bots: {} }]) expect(parseCatalog(body)).toBeNull();
		expect(parseCatalog({ bots: [] })).toEqual([]);
	});
});

describe("parse do detalhe", () => {
	const detail = {
		entry: entry("x"),
		bot: { slug: "x", name: "Resumo", description: "Faz resumos", color: "#1084FE", shape: "blob", suggestedModel: "anthropic/claude-x", starterRoutines: [{ name: "Diário", prompt: "Resuma", cron: "0 9 * * *" }, { name: "", prompt: "p", cron: "0 9 * * *" }, { name: "Semanal", prompt: "Resuma a semana", cron: "0 9 * * 1" }] },
		skills: [{ slug: "daily-report", name: "Relatório", description: "d", blocked: false }, { slug: "ruim", blocked: true }, { nope: 1 }],
	};
	it("mantém o índice original da rotina quando uma inválida é descartada", () => {
		const parsed = parseCatalogDetail(detail)!;
		expect(parsed.routines.map((routine) => [routine.index, routine.name])).toEqual([[0, "Diário"], [2, "Semanal"]]);
		expect(parsed.skills.map((skill) => [skill.slug, skill.name, skill.blocked])).toEqual([["daily-report", "Relatório", false], ["ruim", "ruim", true]]);
		expect(parsed.suggestedModel).toBe("anthropic/claude-x");
	});
	it("resposta parcial: sem habilidades, rotinas nem modelo", () => {
		const parsed = parseCatalogDetail({ bot: { name: "Só nome" }, entry: { slug: "so-nome", description: "do índice" } })!;
		expect(parsed).toMatchObject({ slug: "so-nome", name: "Só nome", description: "do índice", suggestedModel: null, skills: [], routines: [] });
	});
	it("resposta inválida dá null", () => {
		for (const body of [null, {}, { bot: null }, { bot: { name: "x" } }, { bot: { slug: "x" } }, []]) expect(parseCatalogDetail(body)).toBeNull();
	});
});

describe("categorias, filtro e busca", () => {
	const bots = [
		bot("a", { name: "Conversão de moeda", category: "data", description: "Converte valores", tags: ["finanças"] }),
		bot("b", { name: "Revisor de código", category: "dev", description: "Revisa pull requests", skills: ["code-review"] }),
		bot("c", { name: "Agenda do dia", category: "productivity", description: "Resumo da agenda", author: "Maria Souza" }),
	];
	it("rótulos como no web e categoria nova legível", () => {
		expect(categoryLabel("productivity")).toBe("Produtividade");
		expect(categoryLabel("meu-tema")).toBe("Meu tema");
		expect(categoriesOf(bots).map((item) => item.label)).toEqual(["Dados", "Desenvolvimento", "Produtividade"]);
	});
	it("busca sem acento e sem diferença de maiúscula", () => {
		expect(filterCatalog(bots, "CONVERSAO", "").map((item) => item.slug)).toEqual(["a"]);
		expect(filterCatalog(bots, "financas", "").map((item) => item.slug)).toEqual(["a"]);
		expect(filterCatalog(bots, "codigo", "").map((item) => item.slug)).toEqual(["b"]);
	});
	it("várias palavras: todas precisam aparecer, em qualquer ordem e campo", () => {
		expect(filterCatalog(bots, "maria agenda", "").map((item) => item.slug)).toEqual(["c"]);
		expect(filterCatalog(bots, "agenda codigo", "")).toEqual([]);
		expect(filterCatalog(bots, "  revisa   pull ", "").map((item) => item.slug)).toEqual(["b"]);
	});
	it("busca também nas habilidades do bot (hífen vira espaço)", () => {
		expect(filterCatalog(bots, "code review", "").map((item) => item.slug)).toEqual(["b"]);
	});
	it("categoria e busca se combinam", () => {
		expect(filterCatalog(bots, "", "dev").map((item) => item.slug)).toEqual(["b"]);
		expect(filterCatalog(bots, "agenda", "dev")).toEqual([]);
		expect(filterCatalog(bots, "", "")).toHaveLength(3);
	});
});

describe("linhas da lista", () => {
	it("Todos e sem busca: seções por categoria, com título e no máximo SECTION_PREVIEW bots", () => {
		const many = Array.from({ length: SECTION_PREVIEW + 3 }, (_, index) => bot(`p${index}`));
		const rows = buildCatalogRows([...many, bot("d1", { category: "dev" })], "", "");
		expect(rows.filter((row) => row.kind === "header").map((row) => (row.kind === "header" ? [row.label, row.total] : null))).toEqual([["Desenvolvimento", 1], ["Produtividade", SECTION_PREVIEW + 3]]);
		expect(rows.filter((row) => row.kind === "bot")).toHaveLength(SECTION_PREVIEW + 1);
	});
	it("com busca ou categoria: lista plana, sem títulos", () => {
		const bots = [bot("a", { name: "Alfa" }), bot("b", { name: "Beta", category: "dev" })];
		expect(buildCatalogRows(bots, "alfa", "").map((row) => row.key)).toEqual(["a"]);
		expect(buildCatalogRows(bots, "", "dev").map((row) => row.kind)).toEqual(["bot"]);
		expect(buildCatalogRows(bots, "zzz", "")).toEqual([]);
	});
});

describe("instalado derivado", () => {
	it("só conta enquanto o bot criado ainda está na home", () => {
		const map = recordInstall(recordInstall({}, "a", "bot-1"), "b", "bot-2");
		expect([...installedSlugs(map, ["bot-1", "outro"])]).toEqual(["a"]);
		expect([...installedSlugs(map, [])]).toEqual([]);
	});
	it("duas cópias: apagar uma não tira o 'instalado' enquanto a outra existe", () => {
		const map = recordInstall(recordInstall({}, "a", "bot-1"), "a", "bot-2");
		expect(installedSlugs(map, ["bot-2"]).has("a")).toBe(true);
		expect(recordInstall(map, "a", "bot-1")).toBe(map);
	});
	it("armazenamento torto vira mapa vazio e só o formato certo é aceito", () => {
		expect(parseInstalled(null)).toEqual({});
		expect(parseInstalled("{")).toEqual({});
		expect(parseInstalled("[1]")).toEqual({});
		expect(parseInstalled(JSON.stringify({ a: ["x", 1, ""], b: "x", c: [] }))).toEqual({ a: ["x"] });
	});
});
