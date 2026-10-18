import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { nextFileVersion } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { CREATE_FILE_TOOL } from "./tools/create-file.js";
import { createResearchNotes } from "./tools/research-note.js";
import { REGENERATE_FILE_NOTE } from "./execution/delivery-correction.js";
import { applyComputerUseEventsToTranscript, type ComputerUseEvent } from "@workspace/shared";
import { printPdfWithChromium } from "./files/pdf-chromium.js";

/**
 * F4 — verificar antes de entregar. Replay da falha real: pesquisa com PDF em que
 * o rascunho trazia uma cotação que nenhuma fonte tinha e, depois do arquivo, o
 * agente listou erros dele e ofereceu "uma versão corrigida". LLM mockado.
 */

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	persistUserArtifact: vi.fn(async (input: { bytes: Uint8Array; mime: string; meta?: object; kind: string }) => ({
		id: `art-${Math.random().toString(36).slice(2, 8)}`,
		kind: input.kind,
		meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
		runId: "run-verify",
		conversationId: "conv-verify",
		createdAt: new Date(),
	})),
	nextFileVersion: vi.fn(async () => 1),
	countRunFileArtifacts: vi.fn(async () => 0),
}));

vi.mock("./files/pdf-chromium.js", () => ({
	printPdfWithChromium: vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake")),
}));

const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (content: string | null, ...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content, tool_calls: calls },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

type Ev = Record<string, unknown> & { type: string };
type Message = { role: string; content: unknown };

const NOTE = call("n1", "research_note", {
	sourceRef: "https://example.test/pricing",
	findings: "The Pro plan costs 20 dollars per month and includes 5 seats.",
	keyFacts: ["Pro plan: US$ 20 per month", "5 seats"],
	confidence: "high",
});

const FIX_FILE_CALL_TOKENS = 60;

/** `check`: resposta da chamada barata que decide se a resposta final pede regerar o arquivo. */
async function run(script: CompleteChatWithToolsResult[], check: string | Error = '{"fixFile": false}') {
	const events: Ev[] = [];
	let checkCalls = 0;
	const requests: Message[][] = [];
	const queue = [...script];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sem sandbox");
		},
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "Pesquise os planos do produto e gere um PDF com o comparativo." }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-verify",
		runId: "run-verify",
		origin: "chat",
		maxSteps: 12,
		onEvent: (event) => {
			events.push(event as never);
		},
		streamChat: async (params, handlers) => {
			if (params.maxOutputTokens === FIX_FILE_CALL_TOKENS) {
				checkCalls += 1;
				if (check instanceof Error) throw check;
				return { model: "cheap", message: { role: "assistant", content: check }, usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 } };
			}
			requests.push(JSON.parse(JSON.stringify(params.messages)) as Message[]);
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			// Como o streamChat real: o texto da decisão chega em deltas.
			// (aqui em pedaços de 12 caracteres, para os testes verem a progressão)
			const text = next.message.content ?? "";
			for (let at = 0; at < text.length; at += 12) handlers?.onDelta?.(text.slice(at, at + 12));
			return { ...next, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
		},
	} as never);
	return { result, events, requests, checkCalls: () => checkCalls };
}

const publicText = (events: Ev[]) => events.filter((event) => event.type === "assistant_delta").map((event) => String(event.delta));
/** O que o usuário vê: os eventos aplicados ao transcript da UI (inclui retirada de balão). */
const visibleBubbles = (events: Ev[]) =>
	applyComputerUseEventsToTranscript([], events as unknown as ComputerUseEvent[]).map((bubble) => bubble.text).filter((text) => text.trim().length > 0);
const results = (events: Ev[]) => events.filter((event) => event.type === "tool_result");
const printedHtml = () => vi.mocked(printPdfWithChromium).mock.calls.map((args) => String(args[0]));

beforeEach(() => {
	vi.mocked(printPdfWithChromium).mockClear();
	vi.mocked(nextFileVersion).mockReset();
	vi.mocked(nextFileVersion).mockResolvedValue(1);
});

describe("F4: rascunho com número sem fonte é barrado antes do create_file", () => {
	const draft = (extra: string) => ({
		filename: "planos.pdf",
		content: `# Planos\n\nPlano Pro: US$ 20 por mês, 5 assentos.\n\n${extra}`,
	});

	it("a cotação sem fonte volta ao modelo, o arquivo sai com ela marcada e não há 'se quiser, eu gero'", async () => {
		const { result, events, requests } = await run([
			turn("Vou registrar a fonte e montar o PDF.", NOTE),
			turn(null, call("f1", "create_file", draft("Cotação do dólar: R$ 5,87."))),
			turn(null, call("f2", "create_file", { ...draft("Cotação do dólar: R$ 5,87 (não confirmado: nenhuma fonte lida traz a cotação)."), unconfirmed: ["R$ 5,87"] })),
			say("Criei o PDF. A cotação do dólar ficou marcada como não confirmada."),
		]);
		const [noteResult, blocked, created] = results(events);
		expect(noteResult).toMatchObject({ ok: true });
		expect(blocked).toMatchObject({ ok: false });
		expect(String(blocked?.summary)).toContain("5,87");
		expect(String(blocked?.summary)).toContain("list it in unconfirmed");
		expect(created).toMatchObject({ ok: true });
		// Nada foi renderizado com o número sem fonte afirmado como fato.
		expect(printedHtml()).toHaveLength(1);
		expect(printedHtml()[0]).toContain("não confirmado");
		expect(events.filter((event) => event.type === "file")).toHaveLength(1);
		// O erro volta ao modelo no passo seguinte.
		expect(JSON.stringify(requests[2])).toContain("File not created");
		// Resposta final única, sem oferta de refazer o arquivo.
		expect(result.text).toBe("Criei o PDF. A cotação do dólar ficou marcada como não confirmada.");
		expect(result.text).not.toMatch(/se quiser, eu gero/i);
	});

	it("rascunho todo com fonte cria o arquivo de primeira", async () => {
		const { events } = await run([
			turn(null, NOTE),
			turn(null, call("f1", "create_file", draft("Fonte: página de preços."))),
			say("Criei o PDF."),
		]);
		expect(results(events).map((event) => event.ok)).toEqual([true, true]);
		expect(printedHtml()).toHaveLength(1);
	});
});

describe("F4: erro achado depois do arquivo, com orçamento sobrando, regera o arquivo", () => {
	const FIRST = { filename: "planos.pdf", content: "# Planos\n\nPlano Pro: US$ 20 por mês, 10 assentos." };
	const FIXED = { filename: "planos.pdf", content: "# Planos\n\nPlano Pro: US$ 20 por mês, 5 assentos." };

	it("a chamada barata diz fixFile=true: vira nova versão e a admissão não vai ao chat", async () => {
		vi.mocked(nextFileVersion).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
		const admission =
			"Corrijo dois pontos do PDF: o plano Pro tem 5 assentos, não 10. Se quiser, eu gero uma versão corrigida do PDF.";
		const { result, events, requests, checkCalls } = await run(
			[
				turn("Vou pesquisar.", NOTE),
				turn("Montando o arquivo agora.", call("f1", "create_file", FIRST)),
				say(admission),
				turn(null, call("f2", "create_file", FIXED)),
				say("Atualizei o PDF (v2): o plano Pro tem 5 assentos."),
			],
			'{"fixFile": true}',
		);
		// Uma checagem só: a resposta final corrigida não é checada de novo.
		expect(checkCalls()).toBe(1);
		const files = events.filter((event) => event.type === "file");
		expect(files.map((file) => [file.filename, file.version])).toEqual([["planos.pdf", 1], ["planos.pdf", 2]]);
		expect(printedHtml()).toHaveLength(2);
		expect(printedHtml()[1]).toContain("5 assentos");
		// O modelo recebeu o pedido para regerar; a admissão nunca foi ao chat.
		expect(requests[3]?.some((message) => message.role === "system" && message.content === REGENERATE_FILE_NOTE)).toBe(true);
		// A admissão chegou em deltas, mas o balão foi retirado (assistant_discard) antes da regeração.
		expect(publicText(events).join("")).toContain("Se quiser, eu gero");
		const discardAt = events.findIndex((event) => event.type === "assistant_discard");
		expect(discardAt).toBeGreaterThan(-1);
		expect(events.slice(discardAt).some((event) => event.type === "tool_call")).toBe(true);
		const bubbles = visibleBubbles(events);
		expect(bubbles.join("\n")).not.toContain("Se quiser, eu gero");
		expect(bubbles[bubbles.length - 1]).toBe("Atualizei o PDF (v2): o plano Pro tem 5 assentos.");
		expect(result.text).toBe("Atualizei o PDF (v2): o plano Pro tem 5 assentos.");
	});

	it("admissão em alemão também regera: a decisão é da chamada, não de frases", async () => {
		const { result, requests, checkCalls } = await run(
			[
				turn(null, NOTE),
				turn(null, call("f1", "create_file", FIRST)),
				say("Im PDF steht ein Fehler: Der Pro-Plan hat 5 Plätze, nicht 10. Soll ich eine korrigierte Version erstellen?"),
				turn(null, call("f2", "create_file", FIXED)),
				say("PDF aktualisiert (v2)."),
			],
			'{"fixFile": true}',
		);
		expect(checkCalls()).toBe(1);
		expect(requests[3]?.some((message) => message.role === "system" && message.content === REGENERATE_FILE_NOTE)).toBe(true);
		expect(result.text).toBe("PDF aktualisiert (v2).");
	});

	it("fixFile=false, falha ou JSON inválido da chamada: a resposta é aceita como está", async () => {
		for (const check of ['{"fixFile": false}', new Error("provedor fora"), "talvez"]) {
			const { result, checkCalls } = await run(
				[turn(null, NOTE), turn(null, call("f1", "create_file", FIRST)), say("Se quiser, eu gero uma versão corrigida do PDF.")],
				check,
			);
			expect(checkCalls()).toBe(1);
			expect(result.text).toBe("Se quiser, eu gero uma versão corrigida do PDF.");
		}
	});

	it("sem arquivo criado no run, a chamada barata não acontece", async () => {
		const { result, checkCalls } = await run([turn(null, NOTE), say("Corrijo um erro: o plano Pro tem 5 assentos."), say("Corrijo um erro: o plano Pro tem 5 assentos.")], '{"fixFile": true}');
		expect(checkCalls()).toBe(0);
		expect(result.text).toBe("Corrijo um erro: o plano Pro tem 5 assentos.");
	});
});

describe("balões por passo, escritos aos poucos", () => {
	const bubbleIds = (events: Ev[]) => [...new Set(events.filter((event) => event.type === "assistant_delta").map((event) => String(event.id)))];
	const deltasOf = (events: Ev[], id: string) => events.filter((event) => event.type === "assistant_delta" && event.id === id).map((event) => String(event.delta));

	it("cada passo com texto abre o seu balão e todos chegam em vários deltas, antes da tool rodar", async () => {
		const steps = ["Primeiro vou ler as fontes.", "Agora monto o arquivo.", "Criei o PDF com o comparativo."];
		const { events } = await run([
			turn(steps[0]!, NOTE),
			turn(steps[1]!, call("f1", "create_file", { filename: "planos.pdf", content: "# Planos\n\nPlano Pro: US$ 20 por mês." })),
			say(steps[2]!),
		]);
		const ids = bubbleIds(events);
		expect(ids).toHaveLength(3);
		ids.forEach((id, index) => {
			const deltas = deltasOf(events, id);
			expect(deltas.length).toBeGreaterThan(1);
			expect(deltas.join("")).toBe(steps[index]);
		});
		// O texto do passo sai antes do resultado da tool do mesmo passo.
		const firstToolResult = events.findIndex((event) => event.type === "tool_result");
		const lastStepOneDelta = events.map((event) => event.type === "assistant_delta" && event.id === ids[0]).lastIndexOf(true);
		expect(lastStepOneDelta).toBeLessThan(firstToolResult);
		expect(visibleBubbles(events)).toEqual(steps);
	});

	it("a resposta final sem tools também vem em deltas progressivos", async () => {
		const answer = "Resposta direta, escrita aos poucos no mesmo balão.";
		const { events } = await run([say(answer)]);
		const [id] = bubbleIds(events);
		expect(deltasOf(events, id!).length).toBeGreaterThan(3);
		expect(deltasOf(events, id!).join("")).toBe(answer);
	});
});

describe("F4: o filho usa research_note e as notas ficam no armazém do delegate", () => {
	it("origin subagent oferece research_note e grava no researchNotesStore", async () => {
		const store = createResearchNotes();
		const offered: string[][] = [];
		const queue = [turn(null, NOTE), say("Relatório do filho.")];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			model: "m",
			apiKey: "test",
			messages: [{ role: "user", content: "Task: find the plan price." }],
			userId: "user-1",
			runId: "child-1",
			origin: "subagent",
			maxSteps: 6,
			toolFilter: (name: string) => name === "research_note",
			researchNotesStore: store,
			onEvent: () => undefined,
			streamChat: async (params) => {
				offered.push(params.tools.map((tool) => tool.function.name));
				return { ...queue.shift()!, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
			},
		} as never);
		expect(offered[0]).toContain("research_note");
		expect(store.snapshot().map((item) => item.sourceRef)).toEqual(["https://example.test/pricing"]);
	});
});

describe("F4: texto para o modelo", () => {
	it("create_file pede só o que as fontes sustentam e marca o não confirmado", () => {
		expect(CREATE_FILE_TOOL.function.description).toContain("list the figure in unconfirmed and mark it as unconfirmed in the text, in the file's language");
		expect(CREATE_FILE_TOOL.function.parameters.properties).toHaveProperty("unconfirmed");
	});
});
