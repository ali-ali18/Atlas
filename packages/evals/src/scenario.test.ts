import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expectationName, loadScenarios, parseScenario, selectScenarios, type Scenario } from "./scenario.js";

const minimal = { version: 1, id: "exemplo", title: "Exemplo", bot: { name: "Ada" }, user: "oi", expect: [{ type: "completed" }] };

describe("schema do cenário", () => {
	it("aceita o mínimo e preenche os padrões", () => {
		const parsed = parseScenario(minimal);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.scenario.bot.language).toBe("pt-BR");
		expect(parsed.scenario.run).toEqual({ maxSteps: 8, origin: "chat", briefReadOnly: false, engine: "v1" });
		expect(parsed.scenario.tools).toEqual({ fixtures: [], connectors: [], allowReal: [] });
		expect(parsed.scenario.source.kind).toBe("seed");
	});

	it("aceita idioma auto no bot (e só idioma fixo na verificação de idioma)", () => {
		const auto = parseScenario({ ...minimal, bot: { name: "Ada", language: "auto" } });
		expect(auto.ok).toBe(true);
		if (auto.ok) expect(auto.scenario.bot.language).toBe("auto");
		expect(parseScenario({ ...minimal, bot: { name: "Ada", language: "fr-FR" } }).ok).toBe(false);
		expect(parseScenario({ ...minimal, expect: [{ type: "language", value: "auto" }] }).ok).toBe(false);
	});

	it("campo desconhecido é erro (na raiz e dentro de uma expectativa)", () => {
		const root = parseScenario({ ...minimal, expected: [] });
		expect(root.ok).toBe(false);
		const nested = parseScenario({ ...minimal, expect: [{ type: "no_question", strict: true }] });
		expect(nested.ok).toBe(false);
		if (!nested.ok) expect(nested.error).toMatch(/expect\.0/);
	});

	it("versão diferente, id fora do padrão e tipo de verificação inexistente falham", () => {
		expect(parseScenario({ ...minimal, version: 2 }).ok).toBe(false);
		expect(parseScenario({ ...minimal, id: "Com Espaço" }).ok).toBe(false);
		expect(parseScenario({ ...minimal, expect: [{ type: "vibes" }] }).ok).toBe(false);
	});

	it("tool_called sem tool nem toolPattern e text_contains sem valor falham com motivo", () => {
		const tool = parseScenario({ ...minimal, expect: [{ type: "tool_called" }] });
		expect(tool).toMatchObject({ ok: false, error: expect.stringContaining("tool ou toolPattern") });
		const text = parseScenario({ ...minimal, expect: [{ type: "text_contains" }] });
		expect(text).toMatchObject({ ok: false, error: expect.stringContaining("value ou pattern") });
	});

	it("nomes de verificação repetidos pedem um id", () => {
		const parsed = parseScenario({ ...minimal, expect: [{ type: "text_contains", value: "a" }, { type: "text_contains", value: "b" }] });
		expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("nome repetido") });
		expect(parseScenario({ ...minimal, expect: [{ type: "text_contains", value: "a" }, { id: "b", type: "text_contains", value: "b" }] }).ok).toBe(true);
	});

	it("histórico aceita chamadas e resultados de tool", () => {
		const parsed = parseScenario({
			...minimal,
			history: [
				{ role: "user", content: "lista" },
				{ role: "assistant", toolCalls: [{ id: "c1", name: "list_routines" }] },
				{ role: "tool", toolCallId: "c1", content: "nenhuma" },
				{ role: "assistant", content: "Você não tem rotinas." },
			],
		});
		expect(parsed.ok).toBe(true);
	});

	it("nome da verificação: id > tipo:tool > tipo", () => {
		expect(expectationName({ type: "tool_called", tool: "x" })).toBe("tool_called:x");
		expect(expectationName({ type: "tool_not_called", toolPattern: "delete" })).toBe("tool_not_called:delete");
		expect(expectationName({ id: "meu", type: "no_question" })).toBe("meu");
		expect(expectationName({ type: "language", value: "en-US" })).toBe("language:en-US");
	});
});

describe("seleção de cenários", () => {
	const scenarios = [
		{ id: "a", tags: ["x"] },
		{ id: "b", tags: ["y"] },
	] as unknown as Scenario[];
	it("all, ids e tags", () => {
		expect(selectScenarios(scenarios, "all")).toHaveLength(2);
		expect(selectScenarios(scenarios, "b").map((item) => item.id)).toEqual(["b"]);
		expect(selectScenarios(scenarios, "x").map((item) => item.id)).toEqual(["a"]);
	});
	it("id desconhecido é erro (não roda uma bateria vazia em silêncio)", () => {
		expect(() => selectScenarios(scenarios, "z")).toThrow(/desconhecido: z/);
	});
});

describe("any_of, max_context_tokens e opções de run", () => {
	const anyOf = (checks: unknown[]) => parseScenario({ ...minimal, expect: [{ type: "any_of", checks }] });
	const two = [
		{ type: "tool_called", tool: "propose_routine" },
		{ type: "tool_called", tool: "schedule_followup" },
	];

	it("any_of exige 2+ verificações, valida cada uma e não aceita juiz nem any_of aninhado", () => {
		expect(anyOf(two).ok).toBe(true);
		expect(anyOf([two[0]]).ok).toBe(false);
		expect(anyOf([two[0], { type: "tool_called" }])).toMatchObject({ ok: false, error: expect.stringContaining("any_of: tool_called precisa de tool ou toolPattern") });
		expect(anyOf([two[0], { type: "judge", rubric: "A resposta resolve o pedido." }])).toMatchObject({ ok: false, error: expect.stringContaining("any_of não aceita judge") });
		expect(anyOf([two[0], { type: "any_of", checks: two }]).ok).toBe(false);
		expect(anyOf([two[0], { type: "no_question", strict: true }]).ok).toBe(false);
	});

	it("nome de any_of: id ou a lista dos nomes aninhados", () => {
		const parsed = anyOf(two);
		if (!parsed.ok) throw new Error(parsed.error);
		expect(expectationName(parsed.scenario.expect[0]!)).toBe("any_of:tool_called:propose_routine|tool_called:schedule_followup");
		expect(expectationName({ id: "lembrete", type: "any_of", checks: parsed.scenario.expect[0]!.type === "any_of" ? parsed.scenario.expect[0]!.checks : [] })).toBe("lembrete");
	});

	it("max_context_tokens exige inteiro positivo; run aceita proactive e sandbox (opcionais, sem mudar o padrão)", () => {
		expect(parseScenario({ ...minimal, expect: [{ type: "max_context_tokens", value: 6600 }] }).ok).toBe(true);
		expect(parseScenario({ ...minimal, expect: [{ type: "max_context_tokens", value: 0 }] }).ok).toBe(false);
		const run = parseScenario({ ...minimal, run: { proactive: true, sandbox: true } });
		expect(run.ok && run.scenario.run).toMatchObject({ proactive: true, sandbox: true, origin: "chat", engine: "v1" });
		expect(parseScenario({ ...minimal, run: { proativo: true } }).ok).toBe(false);
	});

	it("fixture com `uses` limitado", () => {
		const fixture = { tool: "sandbox_shell", result: { ok: false, summary: "falhou" }, uses: 1 };
		expect(parseScenario({ ...minimal, tools: { fixtures: [fixture] } }).ok).toBe(true);
		expect(parseScenario({ ...minimal, tools: { fixtures: [{ ...fixture, uses: 0 }] } }).ok).toBe(false);
	});
});

describe("carregamento recursivo", () => {
	const dirs: string[] = [];
	afterAll(async () => {
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("sem `recursive` só lê a pasta; com `recursive` desce nas subpastas, em ordem, e acusa id repetido", async () => {
		const root = await mkdtemp(join(tmpdir(), "evals-load-"));
		dirs.push(root);
		await mkdir(join(root, "gold", "email"), { recursive: true });
		await mkdir(join(root, "gold", "agenda"), { recursive: true });
		const write = (path: string, id: string) => writeFile(join(root, path), JSON.stringify({ ...minimal, id }));
		await write("01-raiz.json", "raiz");
		await write("gold/email/02-email.json", "gold-email");
		await write("gold/agenda/01-agenda.json", "gold-agenda");
		await writeFile(join(root, "gold", "email", "leia-me.txt"), "ignorado");
		expect((await loadScenarios(root)).map((item) => item.id)).toEqual(["raiz"]);
		expect((await loadScenarios(root, { recursive: true })).map((item) => item.id)).toEqual(["raiz", "gold-agenda", "gold-email"]);
		await write("gold/email/03-repetido.json", "raiz");
		await expect(loadScenarios(root, { recursive: true })).rejects.toThrow(/cenário repetido: raiz/);
	});

	it("erro de schema cita o caminho do arquivo na subpasta", async () => {
		const root = await mkdtemp(join(tmpdir(), "evals-load-"));
		dirs.push(root);
		await mkdir(join(root, "gold", "email"), { recursive: true });
		await writeFile(join(root, "gold", "email", "01-ruim.json"), JSON.stringify({ ...minimal, expected: [] }));
		await expect(loadScenarios(root, { recursive: true })).rejects.toThrow(/gold[\\/]email[\\/]01-ruim\.json/);
	});
});
