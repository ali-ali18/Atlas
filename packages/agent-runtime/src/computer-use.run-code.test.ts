import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { CodeRunInput, CodeRunResult } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { routeContextGroups } from "./context/intent-router.js";
import { NATIVE_TOOL_GROUPS, nativeToolGroupOf } from "./context/native-tools.js";
import { P_CODE, assembleSystemPrompt } from "./context/prompt-blocks.js";
import { RUN_CODE_TOOL } from "./tools/run-code.js";

/** run_code no loop: funciona com a VM desligada, devolve stdout e entrega arquivos como cartões. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		persistUserArtifact: vi.fn(async (input: { bytes: Uint8Array; mime: string; meta?: object; kind: string }) => ({
			id: "art-rc-1", kind: input.kind, meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
			runId: "run-rc", conversationId: "conv-rc", createdAt: new Date(),
		})),
		nextFileVersion: vi.fn(async () => 1),
		countRunFileArtifacts: vi.fn(async () => 0),
	};
});

const call = (args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: null, tool_calls: [{ id: "rc1", type: "function" as const, function: { name: "run_code", arguments: JSON.stringify(args) } }] },
});

async function run(userText: string, queue: CompleteChatWithToolsResult[], runCode?: (input: CodeRunInput) => Promise<CodeRunResult>, extra: Record<string, unknown> = {}) {
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const offered: string[][] = [];
	const sentMessages: Array<Array<{ role: string; content: unknown }>> = [];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => { throw new Error("sem sandbox"); },
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: userText }],
		botId: "bot-1", userId: "user-1", conversationId: "conv-rc", runId: "run-rc", origin: "chat", maxSteps: 5,
		...(runCode ? { runCodeDeps: { run: runCode, processImage: async () => ({ bytes: Buffer.from("png"), mime: "image/png" as const, width: 10, height: 10 }) } } : {}),
		...extra,
		onEvent: (event) => { events.push(event as never); },
		streamChat: async (params) => {
			offered.push(params.tools.map((t) => t.function.name));
			sentMessages.push(params.messages as never);
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { events, offered, sentMessages };
}

describe("run_code no loop do agente", () => {
	it("pedido de conta/gráfico carrega a ferramenta sem VM; evento tem o código, o stdout e o arquivo gerado", async () => {
		const code = "print(sum([1,2,3]))";
		const runSpy = vi.fn(async (_input: CodeRunInput): Promise<CodeRunResult> => ({
			exitCode: 0, timedOut: false, stdout: "6\n", stderr: "", truncated: false, durationMs: 800, crashed: false, inputNames: [], omitted: [],
			outputs: [{ name: "soma.csv", bytes: new TextEncoder().encode("total\n6\n") }],
		}));
		const { events, offered } = await run("calcula a soma de 1, 2 e 3 e me dá em csv", [
			call({ code }),
			{ model: "test-model", message: { role: "assistant", content: "A soma é 6." } },
		], runSpy);
		expect(offered[0]).toContain("run_code");
		expect(offered[0]).not.toContain("sandbox_shell");
		expect(runSpy).toHaveBeenCalledTimes(1);
		const toolCall = events.find((e) => e.type === "tool_call" && e.name === "run_code") as { args: string } | undefined;
		expect(JSON.parse(toolCall!.args).code).toBe(code);
		const toolResult = events.find((e) => e.type === "tool_result" && e.name === "run_code") as { ok: boolean; summary: string };
		expect(toolResult.ok).toBe(true);
		expect(toolResult.summary).toContain("6");
		const file = events.find((e) => e.type === "file") as { filename: string; artifactId: string } | undefined;
		expect(file).toMatchObject({ filename: "soma.csv", artifactId: "art-rc-1" });
	});

	it("executor ausente: erro amigável chega ao modelo, que responde ao usuário", async () => {
		const { CodeRunnerUnavailableError } = await import("@workspace/sandbox");
		const { events } = await run("calcula a média de 3 e 5", [
			call({ code: "print(4)" }),
			{ model: "test-model", message: { role: "assistant", content: "O executor de código não está instalado." } },
		], async () => { throw new CodeRunnerUnavailableError("O executor de código não está instalado neste servidor."); });
		const toolResult = events.find((e) => e.type === "tool_result" && e.name === "run_code") as { ok: boolean; summary: string };
		expect(toolResult.ok).toBe(false);
		expect(toolResult.summary).toMatch(/executor de código não está instalado/);
	});
});

describe("run_code: gráficos voltam como visão ao modelo", () => {
	const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
	const charts = async (): Promise<CodeRunResult> => ({
		exitCode: 0, timedOut: false, stdout: "", stderr: "", truncated: false, durationMs: 900, crashed: false, inputNames: [], omitted: [],
		outputs: [1, 2, 3].map((n) => ({ name: `g${n}.png`, bytes: PNG })),
	});
	const imageParts = (messages: Array<{ role: string; content: unknown }>) =>
		messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : [])).filter((p) => p.type === "screenshot_ref" || p.type === "image_url");

	it("modelo com visão: no máximo 2 imagens anexadas depois do tool_result", async () => {
		const { sentMessages } = await run("faz um gráfico das vendas", [
			call({ code: "plt.savefig('/work/out/g1.png')" }),
			{ model: "test-model", message: { role: "assistant", content: "Pronto." } },
		], charts, { canSeeUserImages: true, loadScreenshot: async () => "data:image/png;base64,AAAA" });
		const second = sentMessages[1]!;
		expect(imageParts(second)).toHaveLength(2);
		const toolIndex = second.findIndex((m) => m.role === "tool");
		expect(second[toolIndex + 1]!.role).toBe("user");
	});

	it("modelo sem visão: nenhuma imagem volta", async () => {
		const { sentMessages } = await run("faz um gráfico das vendas", [
			call({ code: "plt.savefig('/work/out/g1.png')" }),
			{ model: "test-model", message: { role: "assistant", content: "Pronto." } },
		], charts, { canSeeUserImages: false });
		expect(imageParts(sentMessages[1]!)).toHaveLength(0);
	});
});

describe("grupo `code`", () => {
	it("o roteador pega contas, estatística, gráficos e análise de planilha, mas não navegação", () => {
		for (const text of ["calcula 15% de 2300", "faz um gráfico de barras das vendas", "analisa essa planilha e me dá a média", "qual a mediana desses números"]) {
			expect(routeContextGroups({ text }).has("code"), text).toBe(true);
		}
		expect(routeContextGroups({ text: "abre o site da prefeitura e baixa o PDF" }).has("code")).toBe(false);
		expect(routeContextGroups({ text: "oi, tudo bem?" }).has("code")).toBe(false);
	});

	it("run_code pertence ao grupo code, e o procedimento diz contas/gráficos -> run_code, navegar/dev -> VM", () => {
		expect(NATIVE_TOOL_GROUPS.code.tools).toEqual(["run_code"]);
		expect(nativeToolGroupOf("run_code")).toBe("code");
		const prompt = assembleSystemPrompt(new Set(["code"]));
		expect(prompt).toContain("`run_code`");
		expect(prompt).toMatch(/the VM \(browser\/shell tools\) or a coding session, never `run_code`/);
		expect(assembleSystemPrompt(new Set())).not.toContain("run_code");
		expect(`${P_CODE.join(" ")}${RUN_CODE_TOOL.function.description}`).not.toMatch(/atlas/i);
	});
});
