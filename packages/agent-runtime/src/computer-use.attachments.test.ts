import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { buildAttachmentTurnContext, createExtractCache, type AttachmentRef } from "./attachments/context.js";
import type { AttachmentRuntime } from "./attachments/runtime.js";
import { inProcessExtractor, makePdf } from "./attachments/attachments.fixtures.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const answer: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Li o arquivo." } };
const pdfBytes = makePdf(["Clausula quinta: multa de dez por cento"]);
const pdfRef: AttachmentRef = { id: "pdf1", filename: "contrato.pdf", mime: "application/pdf", size: pdfBytes.byteLength, kind: "pdf" };

async function runtimeFor(nativePdf: boolean): Promise<AttachmentRuntime> {
	const cache = createExtractCache(async (id) => (id === "pdf1" ? pdfBytes : null), { extractor: inProcessExtractor });
	const turn = await buildAttachmentTurnContext([pdfRef], { cache, nativePdf });
	return {
		present: true,
		turnContext: turn.text,
		nativePdfs: turn.nativePdfIds.map((id) => ({ id, filename: "contrato.pdf" })),
		canReadNativePdf: nativePdf,
		list: async () => [pdfRef],
		cache,
		loadPdfDataUrl: async (id) => (id === "pdf1" ? `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}` : null),
	};
}

async function replay(attachments: AttachmentRuntime) {
	let transport: CompleteChatWithToolsParams | undefined;
	let checkpoint: AgentRunCheckpoint | undefined;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "m", apiKey: "test", runId: "run-files", userId: "user-a", origin: "chat",
		messages: [{ role: "user", content: "Resuma o contrato" }],
		attachments,
		sandboxEnabled: false,
		onEvent: () => undefined,
		onCheckpoint: async (value) => { checkpoint = value; },
		streamChat: async (params) => { transport = params; return answer; },
	});
	return { transport, checkpoint };
}

describe("anexos de arquivo no loop", () => {
	it("provedor com PDF nativo: o documento vai só no transporte; o checkpoint guarda a referência", async () => {
		const { transport, checkpoint } = await replay(await runtimeFor(true));
		const user = transport!.messages.filter((message) => message.role === "user").at(-1)!;
		expect(JSON.stringify(user.content)).toContain('"type":"file"');
		expect(JSON.stringify(user.content)).toContain("data:application/pdf;base64,");
		expect(JSON.stringify(user.content)).toContain("contrato.pdf");
		expect(JSON.stringify(checkpoint)).not.toContain("data:application/pdf");
		expect(JSON.stringify(checkpoint)).toContain('"type":"file_ref"');
	});

	it("provedor sem PDF nativo: o texto extraído entra na mensagem e nenhum documento é enviado", async () => {
		const { transport } = await replay(await runtimeFor(false));
		const serialized = JSON.stringify(transport!.messages);
		expect(serialized).toContain("Clausula quinta: multa de dez por cento");
		expect(serialized).not.toContain('"type":"file"');
		expect(serialized).not.toContain("data:application/pdf");
	});

	it("as ferramentas de leitura aparecem só quando há anexos na conversa", async () => {
		const withFiles = await replay(await runtimeFor(false));
		const names = (withFiles.transport!.tools ?? []).map((tool) => tool.function.name);
		expect(names).toContain("attachment_read");
		expect(names).toContain("attachment_list");
		// Sem VM nem sessão de código neste run, não há para onde copiar.
		expect(names).not.toContain("attachment_to_computer");
		let transport: CompleteChatWithToolsParams | undefined;
		await runComputerUse({
			manager: {} as SandboxManager, getSessionId: async () => "unused", model: "m", apiKey: "test", runId: "run-none", userId: "user-a", origin: "chat",
			messages: [{ role: "user", content: "oi" }], sandboxEnabled: false, onEvent: () => undefined,
			streamChat: async (params) => { transport = params; return answer; },
		});
		expect((transport!.tools ?? []).map((tool) => tool.function.name)).not.toContain("attachment_read");
	});

	it("o bot lê o resto pela ferramenta e copia para o computador (VM) com o anexo do dono", async () => {
		const attachments = await runtimeFor(false);
		const writes: Array<{ path: string; size: number }> = [];
		const manager = {
			execWriteFile: async (_session: string, params: { path: string; bytes: Uint8Array }) => { writes.push({ path: params.path, size: params.bytes.byteLength }); return { path: `/home/atlas/work/${params.path}`, bytes: params.bytes.byteLength }; },
		} as unknown as SandboxManager;
		let calls = 0;
		const results: string[] = [];
		await runComputerUse({
			manager, getSessionId: async () => "vm-1", model: "m", apiKey: "test", runId: "run-copy", userId: "user-a", origin: "chat",
			messages: [{ role: "user", content: "Copie o contrato" }], attachments, sandboxEnabled: true, onEvent: () => undefined,
			streamChat: async (params) => {
				calls += 1;
				if (calls === 1) {
					expect((params.tools ?? []).map((tool) => tool.function.name)).toContain("attachment_to_computer");
					return { model: "m", message: { role: "assistant", content: null, tool_calls: [
						{ id: "c1", type: "function", function: { name: "attachment_read", arguments: JSON.stringify({ id: "pdf1", find: "multa" }) } },
						{ id: "c2", type: "function", function: { name: "attachment_to_computer", arguments: JSON.stringify({ id: "pdf1" }) } },
						{ id: "c3", type: "function", function: { name: "attachment_read", arguments: JSON.stringify({ id: "de-outro-usuario" }) } },
					] } };
				}
				for (const message of params.messages) if (message.role === "tool" && typeof message.content === "string") results.push(message.content);
				return answer;
			},
		});
		expect(writes).toEqual([{ path: "anexos/contrato.pdf", size: pdfBytes.byteLength }]);
		expect(results.join("\n")).toContain("multa");
		expect(results.join("\n")).toContain("/home/atlas/work/anexos/contrato.pdf");
		expect(results.join("\n")).toContain("not found in this conversation");
	});
});
