import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatWithTools, type CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { persistConversationCardFromEvent, persistUserArtifact } from "@workspace/db";
import { SYSTEM_PROMPT, runComputerUse } from "./computer-use.js";

/** F9 — replay: pedido de PDF + Word vira 2 create_file, sem colar o texto na resposta. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		persistUserArtifact: vi.fn(async (input: { bytes: Uint8Array; mime: string; meta?: object; kind: string }) => ({
			id: `art-${Math.random().toString(36).slice(2, 8)}`,
			kind: input.kind,
			meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
			runId: "run-files",
			conversationId: "conv-files",
			createdAt: new Date(),
		})),
		nextFileVersion: vi.fn(async () => 1),
		countRunFileArtifacts: vi.fn(async () => 0),
	};
});

vi.mock("./files/pdf-chromium.js", () => ({
	printPdfWithChromium: vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake")),
}));

function toolCalls(calls: Array<{ id: string; args: Record<string, unknown> }>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: calls.map((c) => ({
				id: c.id,
				type: "function" as const,
				function: { name: "create_file", arguments: JSON.stringify(c.args) },
			})),
		},
	};
}

// O docx empacota o jszip; resolve a partir dele para não depender de uma dependência direta nova.
const require = createRequire(import.meta.url);
type Zip = { files: Record<string, unknown>; file(name: string): { async(type: "string"): Promise<string> } | null };
const JSZip = require(require.resolve("jszip", { paths: [require.resolve("docx")] })) as { loadAsync(data: Uint8Array): Promise<Zip> };

const TEXT = "# Meu PVU\n\nParágrafo longo sobre o PVU com **destaque**.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";

async function run(userText: string, queue: CompleteChatWithToolsResult[], origin = "chat") {
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const offered: string[][] = [];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sem sandbox");
		},
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: userText }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-files",
		runId: "run-files",
		origin,
		maxSteps: 6,
		onEvent: (event) => {
			events.push(event as never);
		},
		streamChat: async (params) => {
			offered.push(params.tools.map((t) => t.function.name));
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { events, offered };
}

describe("create_file no loop do agente", () => {
	it("me faz um PDF e um Word do meu PVU -> 2 arquivos, 2 cartões, sem colar o texto", async () => {
		const { events, offered } = await run("me faz um PDF e um Word do meu PVU com este texto", [
			toolCalls([
				{ id: "c1", args: { filename: "pvu.pdf", content: TEXT } },
				{ id: "c2", args: { filename: "pvu.docx", content: TEXT } },
			]),
			{ model: "test-model", message: { role: "assistant", content: "Pronto, criei os dois arquivos." } },
		]);
		expect(offered[0]).toContain("create_file");
		const files = events.filter((e) => e.type === "file");
		expect(files.map((f) => f.filename)).toEqual(["pvu.pdf", "pvu.docx"]);
		expect(files.every((f) => (f.size as number) > 0)).toBe(true);
		expect(vi.mocked(persistUserArtifact)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(persistUserArtifact).mock.calls[0]?.[0]).toMatchObject({ userId: "user-1", kind: "file", conversationId: "conv-files" });
		expect(vi.mocked(persistConversationCardFromEvent)).toHaveBeenCalledWith(
			"conv-files",
			expect.objectContaining({ type: "file", filename: "pvu.docx" }),
		);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results.every((r) => r.ok === true)).toBe(true);
		expect(JSON.stringify(results)).not.toContain("Parágrafo longo");
	});

	it("erro de validação volta ao modelo com ok:false e o run segue", async () => {
		const { events } = await run("faz um arquivo", [
			toolCalls([{ id: "c1", args: { filename: "semextensao", content: "x" } }]),
			{ model: "test-model", message: { role: "assistant", content: "Preciso de um nome com extensão." } },
			// "faz um arquivo" é pedido de arquivo (A3): a resposta sem arquivo ganha um aviso e fecha honesta.
			{ model: "test-model", message: { role: "assistant", content: "Nenhum arquivo foi criado: o nome precisa de extensão." } },
		]);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ ok: false });
		expect(String(result?.summary)).toContain("extension");
		expect(events.some((e) => e.type === "file")).toBe(false);
	});
});

describe("apresentações no loop do agente", () => {
	const MESES = [["2026-08-01", 139800], ["2026-09-01", 148200], ["2026-10-01", 164750]] as const;
	const DECK_ARGS = {
		filename: "vendas-outubro.pptx",
		title: "Vendas de outubro/2026",
		theme: "corporate",
		slides: [
			{ layout: "title", title: "Vendas de outubro/2026", subtitle: "Resultado do mês" },
			{ layout: "agenda", items: ["Resultado", "Evolução", "Próximos passos"] },
			{ layout: "stats", title: "Outubro em números", stats: [{ value: "R$ 164.750", label: "Faturamento", detail: "+11,2% vs. setembro" }] },
			{ layout: "chart", title: "Faturamento cresce há três meses", chart: { type: "bar", x: "mes", series: [{ key: "total", label: "Faturamento" }], data: MESES.map(([mes, total]) => ({ mes, total })), unit: "BRL" } },
			{ layout: "table", title: "Top produtos", columns: ["Produto", "Receita"], rows: [["Adubo", "24.720"]] },
			{ layout: "closing", title: "Próximos passos", bullets: ["Repor estoque"] },
		],
	};

	it("faz uma apresentação das vendas do mês -> um create_file com layouts variados, deck nativo e cartão", async () => {
		const { events } = await run("faz uma apresentação das vendas do mês", [
			toolCalls([{ id: "c1", args: DECK_ARGS }]),
			{ model: "test-model", message: { role: "assistant", content: "Apresentação pronta, com 6 slides." } },
		]);
		const file = events.find((e) => e.type === "file");
		expect(file).toMatchObject({ filename: "vendas-outubro.pptx", format: "pptx" });
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ ok: true });
		expect(String(result?.summary)).toContain("File created: vendas-outubro.pptx");
		expect(String(result?.summary)).toContain("run_code");
		const persisted = vi.mocked(persistUserArtifact).mock.calls.at(-1)![0];
		expect(persisted.mime).toContain("presentationml");
		const zip = await JSZip.loadAsync(persisted.bytes);
		const names = Object.keys(zip.files);
		expect(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(DECK_ARGS.slides.length);
		expect(names.some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
		const layoutsUsed = new Set(DECK_ARGS.slides.map((slide) => slide.layout));
		expect(layoutsUsed.size).toBeGreaterThanOrEqual(5);
	});

	it("layout inválido volta ao modelo com a lista de layouts e nenhum arquivo é criado", async () => {
		const bad = { ...DECK_ARGS, slides: [{ layout: "carrossel", title: "x" }] };
		const { events } = await run("faz uma apresentação das vendas do mês", [
			toolCalls([{ id: "c1", args: bad }]),
			{ model: "test-model", message: { role: "assistant", content: "Vou corrigir o formato." } },
			{ model: "test-model", message: { role: "assistant", content: "Nenhum arquivo foi criado: o layout era inválido." } },
		]);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ ok: false });
		expect(String(result?.summary)).toContain("stats");
		expect(events.some((e) => e.type === "file")).toBe(false);
	});

	it("o prompt manda planejar a narrativa e variar os layouts", () => {
		expect(SYSTEM_PROMPT).toContain("Plan a story first");
		expect(SYSTEM_PROMPT).toContain("never invent them");
	});
});

describe("prompt de arquivos", () => {
	it("manda usar create_file e não colar o documento", () => {
		expect(SYSTEM_PROMPT).toContain("call `create_file` and never paste the whole document in chat");
		expect(SYSTEM_PROMPT).toContain("create it again with the same filename");
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("N5: documento com argumento maior que 4096 tokens é gerado inteiro pelo loop", async () => {
	vi.stubEnv("LLM_MAX_OUTPUT_TOKENS", "");
	const content = "123456789012345678901234567890 ".repeat(5000);
	const args = JSON.stringify({ filename: "documento.txt", content });
	let calls = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).not.toHaveProperty("max_tokens");
			const delta =
				++calls === 1
					? {
							tool_calls: [
								{
									index: 0,
									id: "long-file",
									type: "function",
									function: { name: "create_file", arguments: args },
								},
							],
						}
					: { content: "Arquivo criado." };
			return new Response(
				`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
			);
		}),
	);
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		runId: "run-files",
		userId: "user-1",
		messages: [{ role: "user", content: "Crie um arquivo de texto extenso." }],
		onEvent: () => undefined,
		streamChat: streamChatWithTools,
	});
	const persisted = vi.mocked(persistUserArtifact).mock.calls.at(-1)![0];
	expect(new TextDecoder().decode(persisted.bytes)).toBe(content);
	expect(calls).toBe(2);
});
