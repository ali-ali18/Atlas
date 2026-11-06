import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCapabilityRegistry } from "../capabilities/registry.js";
import { FakeMcp } from "../connectors/fake-mcp.js";
import { createConnectorsCapability } from "../connectors/capability.js";
import { OWNER_DATA_KINDS, PRIVATE_TRUST_SOURCES, TRUST_SOURCES, TRUST_SOURCE_PRIVACY } from "../contract/provenance.js";
import { FakeDeliverables, FakeFileStore, FakeHelpers, FakeMemory, FakeNotebook, FakeSearch, FakeSettings, FakeTaskListStore } from "../presets/fakes.js";
import { PRESET_IDS, setupPreset } from "../presets/presets.js";
import { defineTool, type Tool } from "../tools/define-tool.js";

// Guarda N2 (reauditoria F1): a trifeta (cláusula 8) só fecha se a tool que lê dado do dono DECLARAR `privateData`.
// Sem a flag a trifeta nunca fecha e o egress passa sem cartão. Regra estrutural, sem texto:
//   uma tool `read` cuja origem (`source`) é privada, ou que declara `ownerData`, tem de ter `privateData: true`.
// "Origem privada" vem de `TRUST_SOURCE_PRIVACY` (exaustivo por tipo). Dado do dono confiável (memória) não tem
// `source`: a tool declara `ownerData: "memory"` e o `defineTool` já exige a flag.

/** Tools `read` que viola a regra, com o motivo. */
export function privateDataViolations(tools: readonly Tool[]): string[] {
	const out: string[] = [];
	for (const tool of tools) {
		if (tool.effect !== "read" || tool.privateData) continue;
		if (tool.source !== undefined && PRIVATE_TRUST_SOURCES.includes(tool.source)) out.push(`${tool.name}: source "${tool.source}" é dado do dono, falta privateData: true`);
		if (tool.ownerData !== undefined) out.push(`${tool.name}: ownerData "${tool.ownerData}" sem privateData: true`);
	}
	return out;
}

async function productionTools(): Promise<Tool[]> {
	const tools: Tool[] = [];
	for (const id of PRESET_IDS) {
		// Com todas as portas (e sem a de entregas ricas, para conferir a lite também): toda capacidade do preset entra na varredura.
		const all = { search: new FakeSearch(), files: new FakeFileStore(), memory: new FakeMemory(), notebook: new FakeNotebook(), settings: new FakeSettings(), taskLists: new FakeTaskListStore(), helpers: new FakeHelpers() };
		for (const deps of [all, { ...all, deliverables: new FakeDeliverables().ports() }]) {
			const { registry } = setupPreset(id, deps);
			for (const capability of registry.capabilities) tools.push(...capability.tools);
		}
	}
	// Conectores: um conector privado e um público; as leituras de MCP seguem a privacidade da conexão.
	const mcp = new FakeMcp([
		{ id: "a", ownerId: "o", slug: "gmail", name: "Gmail", catalogId: "gmail", status: "connected", confirmWrites: false, tools: [{ name: "search_messages", inputSchema: {}, annotations: { readOnlyHint: true } }], disabledTools: [] },
		{ id: "b", ownerId: "o", slug: "erp", name: "ERP", catalogId: null, status: "connected", confirmWrites: false, tools: [], disabledTools: [] },
	]);
	const { capability } = await createConnectorsCapability(mcp, "o");
	if (capability) tools.push(...createCapabilityRegistry([capability]).capabilities.flatMap((c) => c.tools));
	return tools;
}

const input = z.object({});
const fake = (name: string, extra: Partial<Parameters<typeof defineTool>[0]>) =>
	defineTool({ name, description: "x", inputSchema: input, effect: "read", execute: () => ({ ok: true, summary: "ok" }), ...extra } as Parameters<typeof defineTool>[0]);

describe("guarda N2: dado do dono declara privateData", () => {
	it("toda tool read de produção com origem privada ou ownerData declara privateData: true", async () => {
		const tools = await productionTools();
		expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["memory_list", "note_search", "note_get", "inspect_file", "web_extract", "research", "mcp_gmail_read"]));
		expect(privateDataViolations(tools)).toEqual([]);
	});

	it("a lista de origens privadas é estrutural e cobre e-mail e arquivo", () => {
		expect([...PRIVATE_TRUST_SOURCES].sort()).toEqual(["email", "file"]);
		for (const source of TRUST_SOURCES) expect(["private", "public", "declared"]).toContain(TRUST_SOURCE_PRIVACY[source]);
		expect(OWNER_DATA_KINDS).toEqual(["email", "file", "memory", "connector"]);
	});

	describe("auto-teste do detector", () => {
		it("pega leitura de e-mail e de arquivo sem a flag", () => {
			const email = fake("read_inbox", { trust: "untrusted", source: "email" });
			const file = fake("inspect_file", { trust: "untrusted", source: "file" });
			expect(privateDataViolations([email, file])).toHaveLength(2);
		});
		it("passa com a flag, e ignora web, outro bot, mcp declarado e tool que não é read", () => {
			const ok = fake("read_inbox", { trust: "untrusted", source: "email", privateData: true });
			const web = fake("web_search", { trust: "untrusted", source: "web" });
			const bot = fake("ask_bot", { trust: "untrusted", source: "other_bot" });
			const mcp = fake("mcp_x_read", { trust: "untrusted", source: "mcp" });
			const write = fake("save_file", { effect: "write_internal", trust: "untrusted", source: "file" });
			expect(privateDataViolations([ok, web, bot, mcp, write])).toEqual([]);
		});
		it("o defineTool não deixa declarar ownerData sem privateData (memória, conector)", () => {
			expect(() => fake("memory_get", { ownerData: "memory" })).toThrow(/privateData: true/);
			expect(fake("memory_get", { ownerData: "memory", privateData: true }).ownerData).toBe("memory");
		});
		it("pega a violação de ownerData numa tool montada à mão (fora do defineTool)", () => {
			const forged = { name: "memory_get", effect: "read", privateData: false, ownerData: "memory" } as unknown as Tool;
			expect(privateDataViolations([forged])).toHaveLength(1);
		});
	});
});
