import { describe, expect, it } from "vitest";
import { createExecutor } from "../../contract/executor.js";
import type { PolicyContext } from "../../contract/authorize.js";
import { FakeMemory, FakeSearch } from "../../presets/fakes.js";
import { createWebCapability } from "../../presets/web.js";
import { fakePorts, sha256 } from "../../testing/fake-ports.js";
import type { ToolContext } from "../../tools/types.js";
import type { Tool } from "../../tools/define-tool.js";
import { createMemoryCapability, MEMORY_CONTENT_MAX_CHARS } from "./memory-capability.js";

const ctx = (ownerId: string): ToolContext => ({ runId: "run-1", ownerId, ports: {} as ToolContext["ports"] });
const toolsOf = (memory: FakeMemory) => Object.fromEntries(createMemoryCapability(memory).tools.map((t) => [t.name, t])) as Record<string, Tool>;

describe("capacidade memory", () => {
	it("efeitos honestos: leitura é read + privateData; escritas são write_internal", () => {
		const t = toolsOf(new FakeMemory());
		expect(t.memory_list).toMatchObject({ effect: "read", privateData: true });
		for (const name of ["memory_add", "memory_update", "memory_remove"]) expect(t[name], name).toMatchObject({ effect: "write_internal", privateData: false });
	});

	it("não é núcleo: o schema só entra no run quando a capacidade é carregada", () => {
		expect(createMemoryCapability(new FakeMemory()).core).toBe(false);
	});

	it("add -> list -> update -> remove, com recibo visível nas escritas", async () => {
		const memory = new FakeMemory();
		const t = toolsOf(memory);
		const added = await t.memory_add!.run({ layer: "owner", content: "Prefere ser chamado de Ali", category: "identity" }, ctx("o1"));
		expect(added).toMatchObject({ ok: true, receipt: { what: "Saved to memory", where: "Owner profile", externalId: "mem-1" } });
		const listed = await t.memory_list!.run({}, ctx("o1"));
		expect(listed.ok && listed.summary).toContain("[mem-1] (owner, identity) Prefere ser chamado de Ali");
		const updated = await t.memory_update!.run({ id: "mem-1", content: "Prefere Ali" }, ctx("o1"));
		expect(updated).toMatchObject({ ok: true, receipt: { externalId: "mem-1" } });
		expect(memory.items[0]?.content).toBe("Prefere Ali");
		expect(await t.memory_remove!.run({ id: "mem-1" }, ctx("o1"))).toMatchObject({ ok: true, receipt: { what: "Removed a memory entry" } });
		const empty = await t.memory_list!.run({ layer: "bot" }, ctx("o1"));
		expect(empty.ok && empty.summary).toContain("No entries");
	});

	it("IDOR: usuário B não lê, altera nem apaga a memória do A (404 honesto, nada muda)", async () => {
		const memory = new FakeMemory();
		const t = toolsOf(memory);
		await t.memory_add!.run({ layer: "owner", content: "segredo do A" }, ctx("userA"));
		const listB = await t.memory_list!.run({}, ctx("userB"));
		expect(listB.ok && listB.summary).toBe("Memory is empty.");
		const update = await t.memory_update!.run({ id: "mem-1", content: "invadido" }, ctx("userB"));
		expect(update).toMatchObject({ ok: false, error: expect.stringContaining("not found"), hint: expect.stringContaining("memory_list") });
		expect(await t.memory_remove!.run({ id: "mem-1" }, ctx("userB"))).toMatchObject({ ok: false });
		expect(memory.items).toEqual([expect.objectContaining({ userId: "userA", content: "segredo do A" })]);
	});

	it("o dono vem do run: um campo userId no argumento é recusado, não obedecido", async () => {
		const memory = new FakeMemory();
		const out = await toolsOf(memory).memory_add!.run({ layer: "owner", content: "x", userId: "userA" }, ctx("userB"));
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s)"), hint: expect.stringContaining("Accepted fields: layer, content, category") });
		expect(memory.items).toHaveLength(0);
	});

	it("validação falha com a lista aceita (camada, tamanho, vazio)", async () => {
		const t = toolsOf(new FakeMemory());
		const badLayer = await t.memory_add!.run({ layer: "team", content: "x" }, ctx("o1"));
		expect(badLayer.ok).toBe(false);
		expect(!badLayer.ok && badLayer.error).toContain("owner");
		expect(!badLayer.ok && badLayer.error).toContain("bot");
		expect((await t.memory_add!.run({ layer: "owner", content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1) }, ctx("o1"))).ok).toBe(false);
		expect((await t.memory_add!.run({ layer: "owner", content: "   " }, ctx("o1"))).ok).toBe(false);
	});

	it("falha do adaptador volta como ok:false com a mensagem real", async () => {
		const memory = new FakeMemory();
		memory.add = async () => {
			throw new Error("Memory is full (1375 characters).");
		};
		expect(await toolsOf(memory).memory_add!.run({ layer: "owner", content: "x" }, ctx("o1"))).toMatchObject({ ok: false, error: "Memory is full (1375 characters)." });
	});
});

describe("memory + trifeta (decide)", () => {
	const policy: PolicyContext = { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] };
	const setup = () => {
		const fake = fakePorts();
		const executor = createExecutor({ runId: "run-1", ownerId: "o1", ports: fake.ports, hash: sha256, policy });
		const web = createWebCapability(new FakeSearch()).tools;
		const memory = createMemoryCapability(new FakeMemory()).tools;
		return { executor, extract: web[1]!, search: web[0]!, list: memory[0]! };
	};

	it("página não confiável + leitura da memória + saída para a web pede aprovação", async () => {
		const { executor, extract, search, list } = setup();
		expect((await executor.executeCall({ callId: "a", step: 0, tool: extract, args: { url: "https://example.test/p" } })).status).toBe("ok");
		expect((await executor.executeCall({ callId: "b", step: 1, tool: list, args: {} })).status).toBe("ok");
		const out = await executor.executeCall({ callId: "c", step: 2, tool: search, args: { query: "consulta montada com o perfil" } });
		expect(out.status).toBe("pending_approval");
	});

	it("sem ler a memória, a pesquisa na web segue livre mesmo depois de ler página", async () => {
		const { executor, extract, search } = setup();
		await executor.executeCall({ callId: "a", step: 0, tool: extract, args: { url: "https://example.test/p" } });
		expect((await executor.executeCall({ callId: "c", step: 1, tool: search, args: { query: "só pública" } })).status).toBe("ok");
	});

	it("ler a memória antes da página também fecha a trifeta", async () => {
		const { executor, extract, search, list } = setup();
		await executor.executeCall({ callId: "b", step: 0, tool: list, args: {} });
		await executor.executeCall({ callId: "a", step: 1, tool: extract, args: { url: "https://example.test/p" } });
		expect((await executor.executeCall({ callId: "c", step: 2, tool: search, args: { query: "x" } })).status).toBe("pending_approval");
	});
});
