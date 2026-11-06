import { describe, expect, it } from "vitest";
import { fakeToolContext } from "../testing.js";
import { defineCapability } from "./define-capability.js";
import { fakeTool } from "./fixtures.js";
import { createLoadedSet } from "./loaded-set.js";
import { createCapabilityRegistry } from "./registry.js";

const make = (id: string, tools: string[], core = false) => defineCapability({ id, title: id, summary: `Does ${id}.`, core, tools: tools.map((t) => fakeTool(t)) });
const registry = createCapabilityRegistry([make("web", ["web_search", "web_fetch"], true), make("tasks", ["update_task_list"], true), make("email", ["email_read", "email_send"]), make("shopping", ["product_search"])]);
const names = (set: ReturnType<typeof createLoadedSet>) => set.toolsForModel().map((t) => t.name);

describe("createLoadedSet", () => {
	it("começa com use_capability e as tools do núcleo (por id)", () => {
		expect(names(createLoadedSet(registry))).toEqual(["use_capability", "update_task_list", "web_search", "web_fetch"]);
	});

	it("carrega no fim e preserva o prefixo byte a byte", () => {
		const set = createLoadedSet(registry);
		const before = JSON.stringify(set.specsForModel());
		const n = set.specsForModel().length;
		expect(set.load("email")).toEqual({ ok: true, added: ["email_read", "email_send"] });
		const afterSpecs = set.specsForModel();
		expect(JSON.stringify(afterSpecs.slice(0, n))).toBe(before);
		expect(afterSpecs.slice(n).map((s) => s.name)).toEqual(["email_read", "email_send"]);
		set.load("shopping");
		expect(JSON.stringify(set.specsForModel().slice(0, n + 2))).toBe(JSON.stringify(afterSpecs));
	});

	it("nunca remove nem reordena: a ordem é a da carga", () => {
		const set = createLoadedSet(registry);
		set.load("shopping");
		set.load("email");
		expect(names(set).slice(-3)).toEqual(["product_search", "email_read", "email_send"]);
		expect(set.loadedIds()).toEqual(["tasks", "web", "shopping", "email"]);
	});

	it("carregar duas vezes é idempotente", () => {
		const set = createLoadedSet(registry);
		set.load("email");
		const snapshot = names(set);
		expect(set.load("email")).toEqual({ ok: true, added: [] });
		expect(set.load("web")).toEqual({ ok: true, added: [] });
		expect(names(set)).toEqual(snapshot);
	});

	it("id desconhecido: erro com os ids válidos", () => {
		const set = createLoadedSet(registry);
		const result = set.load("nada");
		expect(result).toEqual({ ok: false, error: 'Unknown capability "nada". Valid ids: email, shopping, tasks, web.' });
		expect(names(set)).toHaveLength(4);
	});

	it("restaura do checkpoint na mesma ordem", () => {
		const set = createLoadedSet(registry);
		set.load("shopping");
		set.load("email");
		const restored = createLoadedSet(registry, set.loadedIds());
		expect(names(restored)).toEqual(names(set));
	});

	it("use_capability é uma tool de efeito read e carrega pelo executor", async () => {
		const set = createLoadedSet(registry);
		expect(set.useCapabilityTool.effect).toBe("read");
		const ok = await set.useCapabilityTool.run({ id: "email" }, fakeToolContext());
		expect(ok).toEqual({ ok: true, summary: 'Loaded "email". New tools: email_read, email_send.' });
		expect(names(set)).toContain("email_send");
		const again = await set.useCapabilityTool.run({ id: "email" }, fakeToolContext());
		expect(again).toEqual({ ok: true, summary: '"email" was already loaded.' });
		const bad = await set.useCapabilityTool.run({ id: "zzz" }, fakeToolContext());
		expect(bad).toMatchObject({ ok: false, hint: "Valid ids: email, shopping, tasks, web." });
		expect(await set.useCapabilityTool.run({ id: "email", extra: 1 }, fakeToolContext())).toMatchObject({ ok: false, hint: "Accepted fields: id." });
	});
});

describe("instruções lazy da capacidade", () => {
	const guided = defineCapability({ id: "guided", title: "Guiada", summary: "Has notes.", tools: [fakeTool("guided_tool")], instructions: "## Notes\nDo it this way." });

	it("vão no resultado do use_capability ao carregar, uma vez, e nunca antes", async () => {
		const set = createLoadedSet(createCapabilityRegistry([guided]));
		expect(JSON.stringify(set.specsForModel())).not.toContain("Do it this way");
		const first = await set.useCapabilityTool.run({ id: "guided" }, fakeToolContext());
		expect(first.ok && first.summary).toBe('Loaded "Guiada". New tools: guided_tool.\n\n## Notes\nDo it this way.');
		const second = await set.useCapabilityTool.run({ id: "guided" }, fakeToolContext());
		expect(second.ok && second.summary).toBe('"Guiada" was already loaded.');
	});

	it("capacidade sem instrução mantém a resposta de sempre", async () => {
		const set = createLoadedSet(registry);
		const out = await set.useCapabilityTool.run({ id: "shopping" }, fakeToolContext());
		expect(out.ok && out.summary).toBe('Loaded "shopping". New tools: product_search.');
	});
});
