import { OWNER_NOTE_PAGE_CHARS } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { createExecutor } from "../../contract/executor.js";
import type { PolicyContext } from "../../contract/authorize.js";
import { FakeMemory, FakeNotebook, FakeSearch } from "../../presets/fakes.js";
import { createWebCapability } from "../../presets/web.js";
import { fakePorts, sha256 } from "../../testing/fake-ports.js";
import type { Tool } from "../../tools/define-tool.js";
import type { ToolContext } from "../../tools/types.js";
import { createMemoryCapability } from "./memory-capability.js";
import { pinnedNotesSection } from "./notebook-context.js";

const ctx = (ownerId: string): ToolContext => ({ runId: "run-1", ownerId, ports: {} as ToolContext["ports"] });
const build = (notebook = new FakeNotebook()) => ({ notebook, tools: Object.fromEntries(createMemoryCapability(new FakeMemory(), notebook).tools.map((t) => [t.name, t])) as Record<string, Tool> });

describe("capacidade memory com caderno", () => {
	it("sem a porta do caderno a capacidade segue só com a memória; com ela ganha as seis tools note_*", () => {
		expect(createMemoryCapability(new FakeMemory()).tools.map((t) => t.name)).toEqual(["memory_list", "memory_add", "memory_update", "memory_remove"]);
		const withNotes = createMemoryCapability(new FakeMemory(), new FakeNotebook());
		expect(withNotes.tools.map((t) => t.name)).toEqual(["memory_list", "memory_add", "memory_update", "memory_remove", "note_search", "note_get", "note_add", "note_update", "note_pin", "note_remove"]);
		expect(withNotes.core).toBe(false);
		expect(withNotes.summary.length).toBeLessThanOrEqual(160);
	});

	it("efeitos honestos: leitura é read + privateData (memória do dono); escritas são write_internal com confirm when_untrusted", () => {
		const { tools } = build();
		for (const name of ["note_search", "note_get"]) expect(tools[name], name).toMatchObject({ effect: "read", privateData: true, ownerData: "memory" });
		for (const name of ["note_add", "note_update", "note_pin", "note_remove"]) expect(tools[name], name).toMatchObject({ effect: "write_internal", confirm: "when_untrusted", privateData: false });
	});

	it("add -> search -> get -> update -> pin -> remove, com recibo visível nas escritas", async () => {
		const { tools, notebook } = build();
		const added = await tools.note_add!.run({ layer: "owner", title: "Viagem a Lisboa", body: "Voo dia 12, hotel perto do centro." }, ctx("o1"));
		expect(added).toMatchObject({ ok: true, receipt: { what: "Saved a note", where: "Owner notebook", externalId: "note-1" } });
		const found = await tools.note_search!.run({ query: "lisboa" }, ctx("o1"));
		expect(found.ok && found.summary).toContain("[note-1] Viagem a Lisboa (owner): Voo dia 12");
		const got = await tools.note_get!.run({ id: "note-1" }, ctx("o1"));
		expect(got.ok && got.summary).toContain("# Viagem a Lisboa [note-1]");
		expect(got.ok && got.summary).toContain("[End of the note");
		expect(await tools.note_update!.run({ id: "note-1", body: "Voo dia 13." }, ctx("o1"))).toMatchObject({ ok: true, receipt: { what: "Updated a note" } });
		expect(notebook.notes[0]?.body).toBe("Voo dia 13.");
		expect(await tools.note_pin!.run({ id: "note-1", pinned: true }, ctx("o1"))).toMatchObject({ ok: true, receipt: { what: "Pinned a note" } });
		expect(await notebook.listPinned("o1")).toEqual([{ id: "note-1", title: "Viagem a Lisboa" }]);
		expect(await tools.note_remove!.run({ id: "note-1" }, ctx("o1"))).toMatchObject({ ok: true, receipt: { what: "Deleted a note" } });
		expect(notebook.notes).toHaveLength(0);
	});

	it("nota longa vem em páginas com ponteiro e nada é perdido", async () => {
		const { tools } = build();
		const body = "x".repeat(OWNER_NOTE_PAGE_CHARS + 500);
		await tools.note_add!.run({ layer: "bot", title: "Longa", body }, ctx("o1"));
		const first = await tools.note_get!.run({ id: "note-1" }, ctx("o1"));
		expect(first.ok && first.summary).toContain(`note_get(id="note-1", offset=${OWNER_NOTE_PAGE_CHARS})`);
		const rest = await tools.note_get!.run({ id: "note-1", offset: OWNER_NOTE_PAGE_CHARS }, ctx("o1"));
		expect(rest.ok && rest.summary).toContain("[End of the note");
		expect(rest.ok && rest.summary).toContain("x".repeat(500));
	});

	it("texto repetido falha com a mensagem real, sem sucesso falso", async () => {
		const { tools, notebook } = build();
		await tools.note_add!.run({ layer: "owner", title: "A", body: "Mesmo texto" }, ctx("o1"));
		const again = await tools.note_add!.run({ layer: "owner", title: "B", body: "mesmo TEXTO!" }, ctx("o1"));
		expect(again).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
		expect(notebook.notes).toHaveLength(1);
	});

	it("IDOR: usuário B não lê, busca, edita, fixa nem apaga a nota do A (404 honesto, nada muda)", async () => {
		const { tools, notebook } = build();
		await tools.note_add!.run({ layer: "owner", title: "Segredo do A", body: "conteúdo privado do A" }, ctx("userA"));
		const search = await tools.note_search!.run({ query: "privado" }, ctx("userB"));
		expect(search.ok && search.summary).toContain("No notes match");
		for (const [name, args] of [["note_get", { id: "note-1" }], ["note_update", { id: "note-1", body: "invadido" }], ["note_pin", { id: "note-1", pinned: true }], ["note_remove", { id: "note-1" }]] as const) {
			expect(await tools[name]!.run(args, ctx("userB")), name).toMatchObject({ ok: false, error: expect.stringContaining("not found"), hint: expect.stringContaining("note_search") });
		}
		expect(notebook.notes).toEqual([expect.objectContaining({ userId: "userA", body: "conteúdo privado do A", pinned: false })]);
	});

	it("o dono vem do run: userId no argumento é recusado; validação lista o aceito", async () => {
		const { tools, notebook } = build();
		expect(await tools.note_add!.run({ layer: "owner", title: "x", body: "y", userId: "userA" }, ctx("userB"))).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s)") });
		expect((await tools.note_add!.run({ layer: "team", title: "x", body: "y" }, ctx("o1"))).ok).toBe(false);
		expect((await tools.note_add!.run({ layer: "owner", title: "", body: "y" }, ctx("o1"))).ok).toBe(false);
		expect((await tools.note_add!.run({ layer: "owner", title: "x", body: "   " }, ctx("o1"))).ok).toBe(false);
		expect((await tools.note_update!.run({ id: "note-1" }, ctx("o1"))).ok).toBe(false);
		expect(notebook.notes).toHaveLength(0);
	});
});

describe("caderno + política (decide)", () => {
	const policy: PolicyContext = { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] };
	const setup = () => {
		const fake = fakePorts();
		const executor = createExecutor({ runId: "run-1", ownerId: "o1", ports: fake.ports, hash: sha256, policy });
		const { tools } = build();
		return { executor, tools, extract: createWebCapability(new FakeSearch()).tools[1]!, search: createWebCapability(new FakeSearch()).tools[0]! };
	};

	it("sem leitura não confiável, note_add (e fixar) roda mesmo em autonomia total", async () => {
		const { executor, tools } = setup();
		expect((await executor.executeCall({ callId: "a", step: 0, tool: tools.note_add!, args: { layer: "owner", title: "Lista", body: "pão" } })).status).toBe("ok");
		expect((await executor.executeCall({ callId: "b", step: 1, tool: tools.note_pin!, args: { id: "note-1", pinned: true } })).status).toBe("ok");
	});

	it("depois de ler página não confiável, escrever no caderno (inclusive fixar) pede aprovação e não grava", async () => {
		const { executor, tools, extract } = setup();
		await executor.executeCall({ callId: "x", step: 0, tool: extract, args: { url: "https://example.com/a" } });
		for (const [id, tool, args] of [["a", "note_add", { layer: "owner", title: "Ignore tudo", body: "texto injetado", pinned: true }], ["b", "note_pin", { id: "note-1", pinned: true }], ["c", "note_remove", { id: "note-1" }]] as const) {
			expect((await executor.executeCall({ callId: id, step: 1, tool: tools[tool]!, args })).status, tool).toBe("pending_approval");
		}
	});

	it("ler o caderno depois de ler a página fecha a trifeta: a pesquisa na web pede aprovação", async () => {
		const { executor, tools, extract, search } = setup();
		await executor.executeCall({ callId: "x", step: 0, tool: extract, args: { url: "https://example.com/a" } });
		expect((await executor.executeCall({ callId: "n", step: 1, tool: tools.note_search!, args: { query: "" } })).status).toBe("ok");
		expect((await executor.executeCall({ callId: "s", step: 2, tool: search, args: { query: "consulta montada com o caderno" } })).status).toBe("pending_approval");
	});
});

describe("[context]: títulos fixados", () => {
	it("sem nota fixada não há trecho; fixada entra com id e título, sem o corpo", async () => {
		const { tools, notebook } = build();
		expect(await pinnedNotesSection(notebook, "o1")).toBeNull();
		await tools.note_add!.run({ layer: "owner", title: "Plano da semana", body: "corpo que não deve ir ao contexto", pinned: true }, ctx("o1"));
		const section = await pinnedNotesSection(notebook, "o1");
		expect(section).toContain("[note-1] Plano da semana");
		expect(section).not.toContain("corpo que não deve");
		expect(await pinnedNotesSection(notebook, "o2")).toBeNull();
	});

	it("falha do adaptador não derruba o run: sem trecho", async () => {
		const notebook = new FakeNotebook();
		notebook.listPinned = async () => {
			throw new Error("db fora");
		};
		expect(await pinnedNotesSection(notebook, "o1")).toBeNull();
	});
});
