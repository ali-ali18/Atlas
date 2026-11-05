import { describe, expect, it } from "vitest";
import { CHANNELS_PROMPT } from "../channels/index.js";
import { capabilityIndex, createCapabilityRegistry, defineCapability } from "../capabilities/index.js";
import { kernelHarness, reply } from "../testing/kernel-fakes.js";

// Economia (05-fases, guardas permanentes #5): "Bom dia" é barato.
// "Só entra no contexto se for usar" (70-padroes-produto): a primeira chamada ao modelo de um
// "Bom dia" leva só o prompt estável, o `[context]` com o índice de capacidades e as tools do
// núcleo (kernel + `use_capability` + capacidades `core`). Nada de schema de feature lazy.
//
// Esta guarda mede o que o MOTOR monta hoje (sem adaptador, sem conectores). O cenário ouro 24
// "Bom dia" dos evals continua sendo a verificação ponta a ponta com o prompt e as tools reais;
// aqui só se impede que o núcleo engorde sem ninguém notar.
//
// Medida de entrada: caracteres de todas as mensagens + JSON das tools, divididos por 4.
// TETO = medido em 2026-11-05 + 15% (arredondado para cima). Subir o teto exige motivo no commit.
export const GOOD_MORNING_INPUT_TOKENS_MEASURED = 580;
export const GOOD_MORNING_INPUT_TOKENS_CEILING = Math.ceil(GOOD_MORNING_INPUT_TOKENS_MEASURED * 1.15);

const approxTokens = (chars: number) => Math.ceil(chars / 4);

export async function measureGoodMorning(extraCapabilities: Parameters<typeof createCapabilityRegistry>[0] = []) {
	const core = defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: [] });
	const registry = createCapabilityRegistry([core, ...extraCapabilities]);
	const h = kernelHarness([reply({ text: "Bom dia! Como posso ajudar?" })], { capabilities: [core, ...extraCapabilities] });
	const index = capabilityIndex(registry);
	const result = await h.run({ input: { stableSystem: CHANNELS_PROMPT, contextSections: index ? [`Capabilities you can load with use_capability:\n${index}`] : [], history: [{ kind: "owner", text: "Bom dia" }] } });
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

	it("o teto é medido + 15%, e o medido não está defasado (cai dentro de 15% abaixo do teto)", async () => {
		const m = await measureGoodMorning();
		expect(GOOD_MORNING_INPUT_TOKENS_CEILING).toBe(Math.ceil(GOOD_MORNING_INPUT_TOKENS_MEASURED * 1.15));
		// Se o núcleo ENCOLHER bastante, baixe o medido e o teto no mesmo commit (o teto só desce).
		expect(m.tokens).toBeGreaterThanOrEqual(Math.floor(GOOD_MORNING_INPUT_TOKENS_MEASURED * 0.8));
	});
});
