import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutine, getBotProfile } from "@workspace/db";
import { disciplineForModel } from "../context/model-discipline.js";
import { MISSING_ARTIFACT_NOTE } from "../execution/task-state.js";
import { jevSaying, WANTS_FILE_JEV } from "../jev/test-support.js";
import { USER_MESSAGE_HEADER } from "../loop/inputs.js";
import { calls, say, simulate, systemAfterStart, type Simulation } from "./harness.js";
import { endsWithQuestion, SCENARIOS, type ScenarioOutcome } from "./scenarios.js";

/**
 * Simulações de conversa de ponta a ponta (LLM roteirizado, sem rede): cada cenário roda o runtime inteiro e confere
 * o que o usuário veria (balões, cards, texto final) e o que o modelo recebeu (tools, prompt, notas). A checagem de
 * comportamento de `scenarios.ts` é a mesma que o script com modelo real (`scripts/sim-real-model.mts`) usa.
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ name: "Ada", snippet: "", description: "Assistente da loja.", openRouterModel: null, language: "pt-BR" })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	createRoutine: vi.fn(),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	persistUserArtifact: vi.fn(async (input: { bytes: Uint8Array; mime: string; meta?: object; kind: string }) => ({
		id: "art-sim",
		kind: input.kind,
		meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
		runId: "run-sim",
		conversationId: "conv-sim",
		createdAt: new Date(),
	})),
	nextFileVersion: vi.fn(async () => 1),
	countRunFileArtifacts: vi.fn(async () => 0),
}));

vi.mock("../files/pdf-chromium.js", () => ({ printPdfWithChromium: vi.fn(async () => new TextEncoder().encode("%PDF-1.4 sim")) }));

const scenario = (id: number) => SCENARIOS.find((item) => item.id === id)!;
const outcomeOf = (sim: Simulation): ScenarioOutcome => ({
	text: sim.text,
	toolsCalled: sim.toolResults.map((result) => result.name),
	discards: sim.discards,
	systemNotes: sim.requests.map((_, index) => [sim.system(index), ...sim.notes(index)].join("\n")).join("\n"),
});

beforeEach(() => vi.clearAllMocks());

describe("simulações: agir em vez de perguntar", () => {
	it("1. cotação colada + 'altera os dados' → uma resposta final aplicada, sem pergunta nem descarte", async () => {
		const reply = "Bom dia, tudo bem?\nRemetente: CNPJ 12.345.678/0001-95 CEP 01001-000\nDestinatário: CNPJ 98.765.432/0001-98 CEP 20040-020\nCarga: 7 volumes, 43 kg, nota R$ 1.712,67, frete CIF";
		const sim = await simulate({ messages: scenario(1).messages, script: [say(reply)] });
		expect(scenario(1).check(outcomeOf(sim))).toBeNull();
		expect(sim.requests).toHaveLength(1);
		expect(sim.requests[0]!.tools).not.toContain("propose_questionnaire");
		expect(sim.system()).toContain("Act on the most plausible reading.");
		expect(sim.visible).toEqual([reply]);
		expect(sim.discards).toEqual([]);
	});

	it("2. tabela colada + 'usa isso' (outro domínio) → aplica e entrega numa resposta", async () => {
		const reply = "As vendas cresceram no trimestre: camisetas 361, canecas 248, bonés 129.";
		const sim = await simulate({ messages: scenario(2).messages, script: [say(reply)] });
		expect(scenario(2).check(outcomeOf(sim))).toBeNull();
		expect(sim.requests).toHaveLength(1);
		expect(sim.visible).toEqual([reply]);
	});

	it("3. 'me lembra amanhã às 9h' → propõe a rotina direto (card), sem questionário", async () => {
		const runAt = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();
		vi.mocked(createRoutine).mockResolvedValueOnce({
			routine: {
				id: "routine-sim",
				userId: "user-sim",
				botId: "bot-sim",
				conversationId: null,
				name: "Ligar pro fornecedor",
				prompt: "Lembrar de ligar pro fornecedor.",
				model: "",
				enabled: true,
				triggerType: "once",
				schedule: null,
				timezone: "America/Sao_Paulo",
				lastRunAt: null,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
				once: { runAt },
			},
		} as never);
		const sim = await simulate({
			messages: scenario(3).messages,
			script: [calls(["propose_routine", { action: "create", title: "Ligar pro fornecedor", detail: "Lembrar de ligar pro fornecedor.", trigger_type: "once", run_at: runAt }]), say("Combinado: amanhã às 9h te lembro de ligar pro fornecedor.")],
		});
		expect(scenario(3).check(outcomeOf(sim))).toBeNull();
		expect(sim.requests[0]!.tools).toContain("propose_routine");
		expect(sim.requests[0]!.tools).not.toContain("propose_questionnaire");
		expect(sim.toolResults[0]).toMatchObject({ name: "propose_routine", ok: true });
		expect(sim.events.some((event) => event.type === "routine" && event.action === "created")).toBe(true);
		expect(sim.events.some((event) => event.type === "questionnaire")).toBe(false);
	});

	it("4. 'apaga os pedidos' com dois escopos possíveis → uma pergunta curta é permitida (a política deixa)", async () => {
		const question = "Apago só os pedidos de teste ou todos, inclusive os de clientes reais?";
		const sim = await simulate({ messages: scenario(4).messages, script: [say(question)] });
		expect(scenario(4).check(outcomeOf(sim))).toBeNull();
		expect(sim.system()).toContain("Ask only when the missing information cannot be obtained with tools AND the plausible readings lead to materially different, costly or irreversible actions (deleting");
		expect(sim.text).toBe(question);
		expect(endsWithQuestion(sim.text)).toBe(true);
		// O runtime não transforma a pergunta legítima em outra coisa nem a refaz.
		expect(sim.discards).toEqual([]);
		expect(sim.requests).toHaveLength(1);
	});
});

describe("simulações: travas e revisão", () => {
	it("5. modelo fraco promete o PDF sem fazer → um empurrão, o texto anterior fica visível, sem 'o usuário não viu'", async () => {
		const promise = "Vou gerar o PDF agora.";
		const sim = await simulate({
			messages: scenario(5).messages,
			jev: WANTS_FILE_JEV,
			model: "deepseek/deepseek-chat",
			script: [say(promise), calls(["create_file", { filename: "inflacao.pdf", content: "# Inflação\n\nAumento geral dos preços ao longo do tempo." }]), say("Pronto: o PDF sobre inflação está no card acima.")],
		});
		expect(scenario(5).check(outcomeOf(sim))).toBeNull();
		expect(sim.discards).toEqual(["missing_file"]);
		expect(sim.revised).toEqual([[promise, "missing_file"]]);
		expect(sim.visible.at(-1)).toBe("Pronto: o PDF sobre inflação está no card acima.");
		expect(outcomeOf(sim).systemNotes).not.toContain("did NOT see");
		expect(sim.system(1)).toContain(MISSING_ARTIFACT_NOTE);
	});

	it("6a. verificador Jev e checagem do arquivo no chat só observam: a resposta final não é descartada", async () => {
		const decisions: string[] = [];
		const jev = {
			...jevSaying({ wants_file: 0.95, contradicts_evidence: 0.99 }),
			modes: { intent: "on" as const, verify: "on" as const },
			onDecision: (record: { feature: string; mode: string }) => {
				decisions.push(`${record.feature}:${record.mode}`);
			},
		};
		const admission = "Gerei o PDF, mas ele saiu com um erro na tabela. Se quiser, eu corrijo.";
		const sim = await simulate({
			messages: [{ role: "user", content: "me manda um PDF com a tabela de preços" }],
			jev,
			cheapAnswer: '{"fixFile": true, "promisesFile": true}',
			script: [calls(["create_file", { filename: "precos.pdf", content: "# Preços\n\n| Item | Preço |\n|---|---|\n| A | 10 |" }]), say(admission), say("nunca chega")],
		});
		expect(sim.text).toBe(admission);
		expect(sim.discards).toEqual([]);
		expect(sim.requests).toHaveLength(2);
		expect(decisions).toContain("verify:shadow");
	});

	it("6b. teto global: itens abertos refazem uma vez; o arquivo pendente não refaz de novo", async () => {
		const final = "Li os dois itens: A e B estão ok.";
		const sim = await simulate({
			messages: [{ role: "user", content: "confere os itens A e B e me manda um PDF" }],
			jev: jevSaying({ wants_file: 0.95 }),
			script: [
				calls(["track_items", { action: "set", items: [{ label: "A", scope: "lista" }, { label: "B", scope: "lista" }], facts_given: [], plan: ["conferir A", "conferir B"] }]),
				say("Pronto."),
				calls(["track_items", { action: "update", id: "1", status: "done", evidence: "A ok" }], ["track_items", { action: "update", id: "2", status: "done", evidence: "B ok" }]),
				say(final),
			],
		});
		expect(sim.discards).toEqual(["items_open"]);
		expect(sim.text).toBe(final);
		expect(sim.requests.some((_, index) => sim.system(index).includes(MISSING_ARTIFACT_NOTE))).toBe(false);
	});

	it("7. arquivo pedido explicitamente cobra a entrega; sem pedido explícito não há cobrança", async () => {
		const explicit = await simulate({
			messages: [{ role: "user", content: "me manda um PDF com o resumo" }],
			jev: WANTS_FILE_JEV,
			script: [say("Resumo: tudo certo."), say("Não consegui gerar o PDF agora; o resumo está acima.")],
		});
		expect(explicit.discards).toEqual(["missing_file"]);
		const notExplicit = await simulate({
			messages: [{ role: "user", content: "me faz um relatório rápido das vendas aqui no chat" }],
			jev: jevSaying({ wants_file: 0.85 }),
			script: [say("Vendas do mês: 120 pedidos, R$ 30 mil.")],
		});
		expect(notExplicit.discards).toEqual([]);
		expect(notExplicit.requests).toHaveLength(1);
		expect(notExplicit.text).toBe("Vendas do mês: 120 pedidos, R$ 30 mil.");
	});
});

describe("simulações: mensagem do usuário no meio do run", () => {
	it("8. mensagem enviada enquanto o bot trabalha chega ao modelo no mesmo run como fala do usuário", async () => {
		let polls = 0;
		const NOTE = "ah, e inclui o preço de 2025 também";
		const sim = await simulate({
			messages: [{ role: "user", content: "pesquisa o preço do lítio" }],
			script: [
				calls(["memory_search", { query: "lítio" }]),
				calls(["memory_search", { query: "lítio preço" }]),
				say("Lítio: preço atual e o de 2025 incluídos."),
			],
			extra: { consumeSteerInputs: async () => (++polls === 2 ? [{ id: "in-sim", content: NOTE, mode: "join" }] : []) },
		});
		const at = sim.requests.findIndex((request) => request.messages.some((message) => message.role === "user" && String(message.content).includes(NOTE)));
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThan(sim.requests.length);
		const delivered = sim.requests[at]!.messages.find((message) => message.role === "user" && String(message.content).includes(NOTE))!;
		expect(String(delivered.content)).toContain(USER_MESSAGE_HEADER);
		expect(sim.events.some((event) => event.type === "input_consumed")).toBe(true);
		expect(systemAfterStart(sim)).toEqual([]);
		expect(sim.text).toContain("2025");
	});
});

describe("simulações: persona e família do modelo", () => {
	it("9. bot en-US: sem 'português' no prompt e persona uma vez; bot pt-BR: Portuguese", async () => {
		vi.mocked(getBotProfile).mockImplementation(async () => ({ name: "Ada", snippet: "", description: "Store assistant.", openRouterModel: null, language: "en-US" }));
		const en = await simulate({ messages: [{ role: "user", content: "Good morning" }], language: "en-US", script: [say("Good morning!")] });
		expect(en.system()).not.toMatch(/portugu[eê]s|Responda em/i);
		expect(en.system().split("Persona:")).toHaveLength(2);
		expect(en.system().split('You are "Ada"')).toHaveLength(2);
		expect(en.system()).toContain("Always reply to the user in American English.");
		vi.mocked(getBotProfile).mockImplementation(async () => ({ name: "Ada", snippet: "", description: "Assistente da loja.", openRouterModel: null, language: "pt-BR" }));
		const pt = await simulate({ messages: [{ role: "user", content: "Bom dia" }], language: "pt-BR", script: [say("Bom dia!")] });
		expect(pt.system()).toContain("Always reply to the user in Brazilian Portuguese.");
	});

	it("10. DeepSeek recebe a disciplina completa; Claude só o mínimo; 'Bom dia' segue pequeno", async () => {
		const deepseek = await simulate({ messages: [{ role: "user", content: "Bom dia" }], model: "deepseek/deepseek-chat", script: [say("Bom dia!")] });
		const claude = await simulate({ messages: [{ role: "user", content: "Bom dia" }], model: "anthropic/claude-sonnet-4.5", script: [say("Bom dia!")] });
		expect(deepseek.system()).toContain(disciplineForModel("deepseek/deepseek-chat"));
		expect(deepseek.system()).toContain("valid JSON that matches the schema");
		expect(claude.system()).toContain(disciplineForModel("anthropic/claude-sonnet-4.5"));
		expect(claude.system()).not.toContain("valid JSON that matches the schema");
		for (const sim of [deepseek, claude]) {
			const prefix = sim.system().length + JSON.stringify(sim.requests[0]!.toolSchemas).length;
			expect(prefix).toBeLessThan(40_000);
			expect(sim.requests[0]!.tools).not.toContain("propose_questionnaire");
			expect(sim.requests[0]!.tools).not.toContain("propose_plan");
			expect(sim.requests).toHaveLength(1);
		}
	});
});

describe("simulações: transporte tolerante", () => {
	it("11. modelo chama 'List-Routines' com JSON de aspas simples → roda list_routines, nota curta no resultado, sem erro", async () => {
		const torto = calls(["List-Routines", {}]);
		torto.message.tool_calls![0]!.function.arguments = "{'limit': 10,}";
		const sim = await simulate({ messages: scenario(6).messages, script: [torto, say("Você não tem rotinas agendadas.")] });
		expect(scenario(6).check(outcomeOf(sim))).toBeNull();
		expect(sim.toolResults).toEqual([expect.objectContaining({ name: "list_routines", ok: true })]);
		expect(sim.notes(1).join("\n")).toContain("Called `List-Routines` as `list_routines`");
		expect(sim.notes(1).join("\n")).toContain("were not valid JSON");
		expect(sim.requests[1]!.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name)).toEqual(["list_routines"]);
		expect(sim.visible).toEqual(["Você não tem rotinas agendadas."]);
	});
});
