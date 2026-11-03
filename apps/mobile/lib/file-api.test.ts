import { describe, expect, it, vi } from "vitest";
import { ChatApiError } from "./chat-api";
import { MAX_IMAGE_BYTES, MAX_VIEW_BYTES } from "./document-view";
import { downloadFile, downloadForShare, fetchDocument, fileErrorRetryable, fileErrorText, FileTooLargeError } from "./file-api";
import { TimeoutError } from "./with-timeout";

const reply = (body: BodyInit, headers: Record<string, string> = {}, status = 200) => new Response(body, { status, headers });

describe("fetchDocument", () => {
	it("caminho feliz: baixa pelo id codificado e decodifica o UTF-8", async () => {
		const apiFetch = vi.fn(async () => reply("# Olá, instalação", { "content-type": "text/markdown" }));
		const content = await fetchDocument(apiFetch, { id: "f 1", filename: "vm-instalar-apps.md", mime: "text/markdown" });
		expect(apiFetch).toHaveBeenCalledWith("/v1/files/f%201", expect.objectContaining({ signal: expect.anything() }));
		expect(content).toEqual({ type: "text", view: "markdown", text: "# Olá, instalação" });
	});
	it("cartão do chat (só o nome): a extensão decide o tipo", async () => {
		const content = await fetchDocument(async () => reply("a,b\n1,2"), { id: "f", filename: "dados.csv" });
		expect(content).toMatchObject({ type: "text", view: "csv" });
	});
	it("imagem vira data URI com o mime informado", async () => {
		const content = await fetchDocument(async () => reply(new Uint8Array([1, 2, 3])), { id: "f", filename: "a.png", mime: "image/png" });
		expect(content).toEqual({ type: "image", uri: "data:image/png;base64,AQID" });
	});
	it("PDF e Office não são baixados", async () => {
		const apiFetch = vi.fn(async () => reply("x"));
		expect(await fetchDocument(apiFetch, { id: "f", filename: "a.pdf", mime: "application/pdf" })).toEqual({ type: "unsupported" });
		expect(await fetchDocument(apiFetch, { id: "f", filename: "a.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toEqual({ type: "unsupported" });
		expect(apiFetch).not.toHaveBeenCalled();
	});
	it("grande demais: recusa pelo tamanho conhecido, sem baixar", async () => {
		const apiFetch = vi.fn(async () => reply("x"));
		expect(await fetchDocument(apiFetch, { id: "f", filename: "a.md", mime: "text/markdown", size: MAX_VIEW_BYTES + 1 })).toEqual({ type: "too-large" });
		expect(await fetchDocument(apiFetch, { id: "f", filename: "a.png", mime: "image/png", size: MAX_IMAGE_BYTES + 1 })).toEqual({ type: "too-large" });
		expect(apiFetch).not.toHaveBeenCalled();
	});
	it("grande demais: recusa pelo Content-Length e pelo corpo real", async () => {
		const byHeader = await fetchDocument(async () => reply("pequeno", { "content-length": String(MAX_VIEW_BYTES + 10) }), { id: "f", filename: "a.txt", mime: "text/plain" });
		expect(byHeader).toEqual({ type: "too-large" });
		const byBody = await fetchDocument(async () => reply("a".repeat(MAX_VIEW_BYTES + 1)), { id: "f", filename: "a.txt", mime: "text/plain" });
		expect(byBody).toEqual({ type: "too-large" });
		const exact = await fetchDocument(async () => reply("a".repeat(MAX_VIEW_BYTES)), { id: "f", filename: "a.txt", mime: "text/plain" });
		expect(exact).toMatchObject({ type: "text" });
	});
	it("404 (inexistente ou de outro dono) vira ChatApiError e a frase amigável", async () => {
		const error = await fetchDocument(async () => reply("{}", {}, 404), { id: "x", filename: "a.md", mime: "text/markdown" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ChatApiError);
		expect(fileErrorText(error)).toBe("Este documento não existe mais.");
		expect(fileErrorRetryable(error)).toBe(false);
	});
	it("falha de rede: sem conexão, e dá para tentar de novo", async () => {
		const error = await fetchDocument(async () => Promise.reject(new TypeError("Network request failed")), { id: "x", filename: "a.md" }).catch((e: unknown) => e);
		expect(fileErrorText(error)).toBe("Sem conexão com o seu servidor. Tente de novo.");
		expect(fileErrorRetryable(error)).toBe(true);
	});
	it("sessão expirada e erro do servidor", () => {
		expect(fileErrorText(new ChatApiError("x", 401))).toBe("Sua sessão expirou. Entre de novo.");
		expect(fileErrorText(new ChatApiError("x", 500))).toBe("Não consegui abrir este documento agora.");
		expect(fileErrorRetryable(new ChatApiError("x", 500))).toBe(true);
	});
});

describe("leitura em stream sem Content-Length", () => {
	const streamed = (chunks: Uint8Array[], onCancel: () => void) => {
		let index = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index < chunks.length) controller.enqueue(chunks[index++]!);
				else controller.close();
			},
			cancel: onCancel,
		});
		return new Response(body, { status: 200 });
	};
	it("junta os pedaços quando cabe", async () => {
		const file = await downloadFile(async () => streamed([new Uint8Array([1, 2]), new Uint8Array([3])], () => undefined), "f", 10);
		expect([...file.bytes]).toEqual([1, 2, 3]);
	});
	it("corta e cancela ao passar do teto, sem ler o resto", async () => {
		const cancel = vi.fn();
		const error = await downloadFile(async () => streamed([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)], cancel), "f", 10).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FileTooLargeError);
		expect(cancel).toHaveBeenCalled();
	});
});

describe("downloadForShare", () => {
	it("devolve os bytes e o mime", async () => {
		const file = await downloadForShare(async () => reply(new Uint8Array([9, 8]), { "content-type": "application/pdf" }), "f");
		expect([...file.bytes]).toEqual([9, 8]);
		expect(file.mime).toBe("application/pdf");
	});
	it("recusa acima do teto de compartilhar", async () => {
		const error = await downloadForShare(async () => reply("x", { "content-length": String(100 * 1024 * 1024) }), "f").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FileTooLargeError);
		expect(fileErrorText(error)).toBe("Documento grande demais para abrir aqui.");
	});
});

describe("downloadFile: tempo e teto", () => {
	it("aborta a rede e rejeita com TimeoutError quando o servidor não responde", async () => {
		let signal: AbortSignal | undefined;
		const hang = async (_path: string, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return new Promise<Response>(() => undefined);
		};
		const error = await downloadFile(hang, "f", 10, 20).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TimeoutError);
		expect(signal?.aborted).toBe(true);
	});
	it("sem stream nem Content-Length, corpo acima do teto é rejeitado", async () => {
		const big = async () => ({ ok: true, status: 200, statusText: "", headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(20) }) as unknown as Response;
		await expect(downloadFile(big, "f", 10)).rejects.toBeInstanceOf(FileTooLargeError);
	});
});
