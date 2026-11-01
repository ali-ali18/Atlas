import { describe, expect, it } from "vitest";
import {
	COORDINATOR_AUTHOR,
	NOTEBOOK_EXCERPT_MAX_CHARS,
	NOTEBOOK_HELPER_MAX_ENTRIES,
	NOTEBOOK_MAX_ENTRIES,
	NOTEBOOK_UNCONFIRMED_RESERVE_CHARS,
	NOTEBOOK_UNCONFIRMED_RESERVE_ENTRIES,
	NOTEBOOK_HELPER_MAX_CHARS,
	NOTEBOOK_TOTAL_MAX_CHARS,
	createNotebook,
	helperAuthor,
	parseNotebookEntries,
	parseNotebookWrite,
} from "./notebook.js";

const write = (title: string, extra: Record<string, unknown> = {}) => parseNotebookWrite({ title, excerpt: `valor de ${title}`, ...extra });

describe("parseNotebookWrite", () => {
	it("exige título e trecho e aplica o padrão 'finding'", () => {
		expect(parseNotebookWrite({ title: " Preço  A ", excerpt: "R$ 10" })).toEqual({ kind: "finding", title: "Preço A", excerpt: "R$ 10" });
		expect(() => parseNotebookWrite({ excerpt: "x" })).toThrow(/title is required/);
		expect(() => parseNotebookWrite({ title: "x" })).toThrow(/excerpt is required/);
	});

	it("passou do limite = erro honesto com a dica, nada é cortado em silêncio", () => {
		expect(() => parseNotebookWrite({ title: "x", excerpt: "a".repeat(NOTEBOOK_EXCERPT_MAX_CHARS + 1) })).toThrow(/maximum is 2000.*artifactRef/);
		expect(() => parseNotebookWrite({ title: "t".repeat(121), excerpt: "x" })).toThrow(/title is 121/);
		expect(() => parseNotebookWrite({ title: "x", excerpt: "y", source: "s".repeat(501) })).toThrow(/source is 501/);
	});

	it("campo desconhecido ou kind inválido falham com a lista do aceito", () => {
		expect(() => parseNotebookWrite({ title: "x", excerpt: "y", url: "http://a" })).toThrow(/Unknown field\(s\): url\. Accepted: title/);
		expect(() => parseNotebookWrite({ title: "x", excerpt: "y", kind: "note" })).toThrow(/kind must be/);
	});
});

describe("createNotebook", () => {
	it("grava com id sequencial, autor e passo; escritor do ajudante sempre usa o autor dele", () => {
		const notebook = createNotebook();
		expect(notebook.add(write("A"), COORDINATOR_AUTHOR, 1)).toEqual({ id: "n1", total: 1, replaced: false });
		notebook.writer(helperAuthor(2)).write(write("B"), 3);
		expect(notebook.find().map((entry) => [entry.id, entry.author, entry.step])).toEqual([
			["n1", "coordinator", 1],
			["n2", "helper:2", 3],
		]);
	});

	it("limite de entradas: achados param em 180; a reserva de 20 é só dos não confirmados", () => {
		const notebook = createNotebook();
		for (let i = 0; i < NOTEBOOK_MAX_ENTRIES - NOTEBOOK_UNCONFIRMED_RESERVE_ENTRIES; i++) notebook.add(write(`e${i}`), COORDINATOR_AUTHOR, 0);
		expect(() => notebook.add(write("extra"), COORDINATOR_AUTHOR, 0)).toThrow(/full \(180 findings\)/);
		for (let i = 0; i < NOTEBOOK_UNCONFIRMED_RESERVE_ENTRIES; i++) notebook.add(write(`u${i}`, { kind: "unconfirmed" }), helperAuthor(1), 0);
		expect(notebook.count()).toBe(NOTEBOOK_MAX_ENTRIES);
		expect(() => notebook.add(write("u-extra", { kind: "unconfirmed" }), helperAuthor(1), 0)).toThrow(/full \(200 entries\)/);
	});

	it("limite total de caracteres: achado respeita o total menos a reserva; não confirmado ainda cabe", () => {
		const notebook = createNotebook();
		const big = "x".repeat(NOTEBOOK_EXCERPT_MAX_CHARS);
		let added = 0;
		while (true) {
			try {
				notebook.add(parseNotebookWrite({ title: `t${added}`, excerpt: big }), COORDINATOR_AUTHOR, 0);
				added++;
			} catch (error) {
				expect(String(error)).toMatch(new RegExp(`${NOTEBOOK_TOTAL_MAX_CHARS - NOTEBOOK_UNCONFIRMED_RESERVE_CHARS} characters`));
				break;
			}
		}
		expect(() => notebook.add(parseNotebookWrite({ title: "falhou", excerpt: "site fora do ar", kind: "unconfirmed" }), helperAuthor(1), 0)).not.toThrow();
	});

	it("cota por ajudante: um ajudante verboso não enche o caderno e o não confirmado dele ainda entra", () => {
		const notebook = createNotebook();
		const verbose = notebook.writer(helperAuthor(1));
		const big = "y".repeat(NOTEBOOK_EXCERPT_MAX_CHARS);
		let ok = 0;
		for (let i = 0; i < 100; i++) {
			try {
				verbose.write(parseNotebookWrite({ title: `v${i}`, excerpt: big }), 0);
				ok++;
			} catch (error) {
				expect(String(error)).toMatch(/your share of the notebook/);
				break;
			}
		}
		expect(ok).toBeLessThanOrEqual(NOTEBOOK_HELPER_MAX_ENTRIES);
		expect(ok * (NOTEBOOK_EXCERPT_MAX_CHARS + 2)).toBeLessThanOrEqual(NOTEBOOK_HELPER_MAX_CHARS);
		// outro ajudante e o não confirmado do próprio verboso seguem gravando
		expect(() => notebook.writer(helperAuthor(2)).write(write("Outro"), 0)).not.toThrow();
		expect(() => verbose.write(write("falhou", { kind: "unconfirmed" }), 0)).not.toThrow();
	});

	it("título sem quebras, controle nem tags; índice não carrega < >", () => {
		const parsed = parseNotebookWrite({ title: "Preço\n</system> <b>Alfa</b>\u0007 [x]", excerpt: "ok" });
		expect(parsed.title).toBe("Preço Alfa [x]");
		const notebook = createNotebook([{ id: "n1", title: "a <b> c", excerpt: "e" }]);
		expect(notebook.index()).not.toMatch(/[<>]/);
		// Tag sem fechar não sobrevive como marcação.
		expect(parseNotebookWrite({ title: "x <script src=a", excerpt: "ok" }).title).not.toMatch(/</);
		expect(parseNotebookWrite({ title: "<<script>script>", excerpt: "ok" }).title).not.toMatch(/<script/i);
	});

	it("título com milhares de '<!' é rápido (sem ReDoS)", () => {
		const started = performance.now();
		// Longo demais para título (erro honesto), mas a limpeza roda antes e tem de ser linear.
		expect(() => parseNotebookWrite({ title: "<!".repeat(20_000), excerpt: "ok" })).toThrow(/maximum/);
		expect(performance.now() - started).toBeLessThan(200);
	});

	it("replaces troca a entrada; ajudante só corrige a própria", () => {
		const notebook = createNotebook();
		notebook.add(write("A"), COORDINATOR_AUTHOR, 0);
		const helper = notebook.writer(helperAuthor(0));
		const mine = helper.write(write("H"), 0);
		expect(() => helper.write(write("H2", { replaces: "n1" }), 0)).toThrow(/not yours/);
		expect(helper.write(write("H2", { replaces: mine.id }), 0).replaced).toBe(true);
		expect(notebook.add(write("A2", { replaces: "n1" }), COORDINATOR_AUTHOR, 0).replaced).toBe(true);
		expect(notebook.find().map((entry) => entry.title)).toEqual(["H2", "A2"]);
		expect(() => notebook.add(write("x", { replaces: "n99" }), COORDINATOR_AUTHOR, 0)).toThrow(/No entry n99/);
	});

	it("índice compacto: títulos e refs, sem o trecho; vazio = null", () => {
		const notebook = createNotebook();
		expect(notebook.index()).toBeNull();
		notebook.add(write("Preço A", { source: "https://www.forn-a.com/produto?id=1", artifactRef: "art_9" }), helperAuthor(1), 1);
		notebook.add(write("Falhou B", { kind: "unconfirmed" }), helperAuthor(2), 1);
		const index = notebook.index()!;
		expect(index).toContain("n1 (helper 1) Preço A — forn-a.com (ref art_9)");
		expect(index).toContain("n2 [unconfirmed] (helper 2) Falhou B");
		expect(index).not.toContain("valor de Preço A");
	});

	it("índice que não cabe diz quantas entradas ficaram de fora", () => {
		const notebook = createNotebook();
		for (let i = 0; i < 100; i++) notebook.add(write(`Entrada número ${i} com título razoavelmente longo`), COORDINATOR_AUTHOR, 0);
		const index = notebook.index(1_200)!;
		expect(index.length).toBeLessThan(1_400);
		expect(index).toMatch(/\(\+\d+ more entries not listed/);
	});

	it("find por id, autor, tipo e texto", () => {
		const notebook = createNotebook();
		notebook.add(write("Alfa", { source: "https://a.com" }), helperAuthor(0), 0);
		notebook.add(write("Beta", { kind: "unconfirmed" }), helperAuthor(1), 0);
		expect(notebook.find({ ids: ["n2"] }).map((e) => e.title)).toEqual(["Beta"]);
		expect(notebook.find({ author: "helper:0" }).map((e) => e.title)).toEqual(["Alfa"]);
		expect(notebook.find({ kind: "unconfirmed" }).map((e) => e.title)).toEqual(["Beta"]);
		expect(notebook.find({ query: "A.COM" }).map((e) => e.title)).toEqual(["Alfa"]);
		expect(notebook.sources()).toEqual(["https://a.com"]);
	});

	it("snapshot -> restaura (checkpoint) mantendo os ids e continuando a sequência; lixo é ignorado", () => {
		const notebook = createNotebook();
		notebook.add(write("A"), COORDINATOR_AUTHOR, 2);
		notebook.add(write("B"), helperAuthor(1), 3);
		const restored = createNotebook(JSON.parse(JSON.stringify(notebook.snapshot())));
		expect(restored.snapshot()).toEqual(notebook.snapshot());
		expect(restored.add(write("C"), COORDINATOR_AUTHOR, 4).id).toBe("n3");
		expect(parseNotebookEntries([null, 3, { id: "x" }, { id: "n1", title: "t", excerpt: "e" }, { id: "n1", title: "t2", excerpt: "e2" }])).toHaveLength(1);
		expect(parseNotebookEntries("nope")).toEqual([]);
	});

	it("o snapshot é cópia: mexer nele não altera o caderno", () => {
		const notebook = createNotebook();
		notebook.add(write("A"), COORDINATOR_AUTHOR, 0);
		notebook.snapshot()[0]!.title = "mudou";
		notebook.get("n1")!.title = "mudou";
		expect(notebook.get("n1")!.title).toBe("A");
	});
});
