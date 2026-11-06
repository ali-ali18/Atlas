import { describe, expect, it } from "vitest";
import { createCapabilityRegistry, defineCapability } from "../capabilities/index.js";
import { createConnectorsCapability } from "../connectors/capability.js";
import { FakeMcp } from "../connectors/fake-mcp.js";
import { createDeliverablesCapability } from "../capabilities-builtin/deliverables/index.js";
import { createAgendaCapability } from "../capabilities/agenda/index.js";
import { createResearchCapability } from "../capabilities-builtin/research/index.js";
import { FakeAgenda, FakeDeliverables, FakeHelpers } from "../presets/fakes.js";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";

// Economia (05-fases, guardas permanentes #5): "Bom dia" é barato.
// "Só entra no contexto se for usar" (70-padroes-produto): a primeira chamada ao modelo de um
// "Bom dia" leva só o prompt estável, o `[context]` com o índice de capacidades e as tools do
// núcleo (kernel + `use_capability` + capacidades `core`). Nada de schema de feature lazy.
//
// Esta guarda mede o que o MOTOR monta hoje (sem adaptador, sem conectores). O cenário ouro 24
// "Bom dia" dos evals continua sendo a verificação ponta a ponta com o prompt e as tools reais;
// aqui só se impede que o núcleo engorde sem ninguém notar.
//
// O QUE ESTA MEDIDA É (e não é): uma aproximação do ESQUELETO que o motor monta (prompt estável + `[context]` + JSON das
// tools do núcleo), em caracteres/4. Não é a contagem do tokenizer do modelo, não inclui tools de preset, conectores nem o
// prompt que o worker injeta, e não prova custo em dinheiro. Serve para impedir que o núcleo engorde sem ninguém ver (só o
// TETO protege; o medido abaixo do teto não é um piso). O custo real de "Bom dia" é conferido no eval ouro 24.
//
// Medida de entrada: caracteres de todas as mensagens + JSON das tools, divididos por 4.
// TETO = medido em 2026-11-05 + 15% (arredondado para cima). Subir o teto exige motivo no commit.
export const GOOD_MORNING_INPUT_TOKENS_MEASURED = 902; // prompt estável completo (contrato de trabalho + canais), medido depois da F1.11
export const GOOD_MORNING_INPUT_TOKENS_CEILING = Math.ceil(GOOD_MORNING_INPUT_TOKENS_MEASURED * 1.15);

const approxTokens = (chars: number) => Math.ceil(chars / 4);

export async function measureGoodMorning(extraCapabilities: Parameters<typeof createCapabilityRegistry>[0] = []) {
	const core = defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: [] });
	const h = kernelHarness([reply({ text: "Bom dia! Como posso ajudar?" })], { capabilities: [core, ...extraCapabilities] });
	// Sem `stableSystem`: o kernel monta o prompt estável real (contrato de trabalho + canais + índice de capacidades, F1.11).
	const result = await h.run({ input: { contextSections: [], history: [{ kind: "owner", text: "Bom dia" }] } });
	const first = h.llm.requests[0];
	if (!first) throw new Error("o modelo não foi chamado");
	const messageChars = JSON.stringify(first.messages).length;
	const toolChars = JSON.stringify(first.tools ?? []).length;
	return { result, steps: h.llm.requests.length, toolNames: (first.tools ?? []).map((t) => t.name), messageChars, toolChars, tokens: approxTokens(messageChars + toolChars) };
}

describe("economia: Bom dia", () => {
	it("a primeira chamada fica abaixo do teto de tokens de entrada", async () => {
		const m = await measureGoodMorning();
		expect(m.result.status).toBe("done");
		expect(m.steps).toBe(1); // saudação = uma chamada, sem tool
		expect(m.tokens, `Bom dia custa ~${m.tokens} tokens de entrada (mensagens ${m.messageChars} + tools ${m.toolChars} caracteres); teto ${GOOD_MORNING_INPUT_TOKENS_CEILING}. Mova schema/instrução de feature para uma capacidade lazy (use_capability) em vez de subir o teto.`).toBeLessThanOrEqual(GOOD_MORNING_INPUT_TOKENS_CEILING);
	});

	it("só as tools do núcleo vão no primeiro passo", async () => {
		const m = await measureGoodMorning();
		expect(m.toolNames).toEqual(["note_read", "ask_owner", "use_capability"]);
	});

	it("capacidade não-núcleo entra só como uma linha do índice, sem as tools", async () => {
		const lazy = defineCapability({ id: "web", title: "Web", summary: "Search and read pages.", tools: [] });
		const base = await measureGoodMorning();
		const withLazy = await measureGoodMorning([lazy]);
		expect(withLazy.toolNames).toEqual(base.toolNames);
		expect(withLazy.tokens - base.tokens).toBeLessThan(60);
	});

	it("conectores do dono entram só como uma linha do índice: nem tool_search nem mcp_* vão no primeiro passo", async () => {
		const mcp = new FakeMcp([{ id: "a", ownerId: "o", slug: "gmail", name: "Gmail", catalogId: "gmail", status: "connected", confirmWrites: true, tools: Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: "x".repeat(300), inputSchema: { type: "object" } })), disabledTools: [] }]);
		const { capability } = await createConnectorsCapability(mcp, "o");
		const base = await measureGoodMorning();
		const withConnectors = await measureGoodMorning(capability ? [capability] : []);
		expect(capability?.core).toBe(false);
		expect(withConnectors.toolNames).toEqual(base.toolNames);
		expect(withConnectors.tokens - base.tokens).toBeLessThan(60);
		expect(withConnectors.tokens).toBeLessThanOrEqual(GOOD_MORNING_INPUT_TOKENS_CEILING);
	});

	it("a capacidade deliverables é lazy: 'Bom dia' não ganha tool nem os moldes, só uma linha do índice", async () => {
		const base = await measureGoodMorning();
		const withDeliverables = await measureGoodMorning([createDeliverablesCapability(new FakeDeliverables().ports())]);
		expect(withDeliverables.toolNames).toEqual(base.toolNames);
		expect(withDeliverables.toolNames).not.toContain("create_file");
		expect(withDeliverables.tokens - base.tokens).toBeLessThan(60);
		const sent = JSON.stringify(withDeliverables.result);
		expect(sent).not.toContain("Academic work (ABNT)");
		expect(withDeliverables.tokens).toBeLessThanOrEqual(GOOD_MORNING_INPUT_TOKENS_CEILING + 60);
	});

	it("o pedido de arquivo carrega a capacidade no passo 1 e os moldes só então", async () => {
		const core = defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: [] });
		const h = kernelHarness([reply({ calls: [call("c1", "use_capability", { id: "deliverables" })] }), reply({ text: "Pronto." })], {
			capabilities: [core, createDeliverablesCapability(new FakeDeliverables().ports())],
		});
		await h.run({ input: { contextSections: [], history: [{ kind: "owner", text: "Faça um relatório em Word" }] } });
		const [first, second] = h.llm.requests;
		expect(JSON.stringify(first?.messages)).not.toContain("Academic work (ABNT)");
		expect((first?.tools ?? []).map((t) => t.name)).not.toContain("create_file");
		expect((second?.tools ?? []).map((t) => t.name)).toEqual(expect.arrayContaining(["create_file", "create_page", "chart", "inspect_file"]));
		expect(JSON.stringify(second?.messages)).toContain("Academic work (ABNT)");
	});

	it("a capacidade research é lazy: 'Bom dia' não ganha a tool nem as instruções, só uma linha do índice", async () => {
		const base = await measureGoodMorning();
		const withResearch = await measureGoodMorning([createResearchCapability(new FakeHelpers())]);
		expect(withResearch.toolNames).toEqual(base.toolNames);
		expect(withResearch.toolNames).not.toContain("research");
		expect(withResearch.tokens - base.tokens).toBeLessThan(60);
		expect(JSON.stringify(withResearch.result)).not.toContain("One source per claim");
		expect(withResearch.tokens).toBeLessThanOrEqual(GOOD_MORNING_INPUT_TOKENS_CEILING + 60);
	});

	it("o pedido de pesquisa carrega a capacidade no passo 1 e as instruções só então", async () => {
		const core = defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: [] });
		const h = kernelHarness([reply({ calls: [call("c1", "use_capability", { id: "research" })] }), reply({ text: "Pronto." })], { capabilities: [core, createResearchCapability(new FakeHelpers())] });
		await h.run({ input: { contextSections: [], history: [{ kind: "owner", text: "Compare 10 fornecedores de pagamento com preço e fonte" }] } });
		const [first, second] = h.llm.requests;
		expect(JSON.stringify(first?.messages)).not.toContain("One source per claim");
		expect((first?.tools ?? []).map((t) => t.name)).not.toContain("research");
		expect((second?.tools ?? []).map((t) => t.name)).toContain("research");
		expect(JSON.stringify(second?.messages)).toContain("One source per claim");
	});

	it("a capacidade agenda é lazy: 'Bom dia' não ganha remind_me, watch nem on_event, só uma linha do índice", async () => {
		const base = await measureGoodMorning();
		const withAgenda = await measureGoodMorning([createAgendaCapability(new FakeAgenda())]);
		expect(withAgenda.toolNames).toEqual(base.toolNames);
		for (const name of ["remind_me", "watch", "on_event", "agenda_list", "agenda_change", "agenda_result"]) expect(withAgenda.toolNames).not.toContain(name);
		expect(withAgenda.tokens - base.tokens).toBeLessThan(60);
		expect(JSON.stringify(withAgenda.result)).not.toContain("Agenda rules");
		expect(withAgenda.tokens).toBeLessThanOrEqual(GOOD_MORNING_INPUT_TOKENS_CEILING + 60);
	});

	it("o pedido de lembrete carrega a capacidade no passo 1 e as instruções só então", async () => {
		const core = defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: [] });
		const h = kernelHarness([reply({ calls: [call("c1", "use_capability", { id: "agenda" })] }), reply({ text: "Pronto." })], { capabilities: [core, createAgendaCapability(new FakeAgenda())] });
		await h.run({ input: { contextSections: [], history: [{ kind: "owner", text: "Me lembra amanhã às 10h de ligar para o contador" }] } });
		const [first, second] = h.llm.requests;
		expect(JSON.stringify(first?.messages)).not.toContain("Agenda rules");
		expect((first?.tools ?? []).map((t) => t.name)).not.toContain("remind_me");
		expect((second?.tools ?? []).map((t) => t.name)).toEqual(expect.arrayContaining(["remind_me", "watch", "on_event", "agenda_list", "agenda_change"]));
		expect(JSON.stringify(second?.messages)).toContain("Agenda rules");
	});

	it("o teto é o medido + 15% (o teto só desce: se o núcleo encolher, baixe o medido e o teto no mesmo commit)", () => {
		expect(GOOD_MORNING_INPUT_TOKENS_CEILING).toBe(Math.ceil(GOOD_MORNING_INPUT_TOKENS_MEASURED * 1.15));
	});
});
