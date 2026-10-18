import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, attachmentKindOf, classifyAttachment, supportsNativePdf } from "./attachments.js";
import { fileCategory } from "./files.js";
import { parseConversationCard } from "./skill-card.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("classifyAttachment", () => {
	it("tipo vem do conteúdo, não do MIME: PDF, Office, zip, csv, texto, binário", () => {
		expect(classifyAttachment("a.pdf", bytes("%PDF-1.7 x"))).toMatchObject({ ok: true, kind: "pdf", mime: "application/pdf" });
		expect(classifyAttachment("a.docx", bytes("PK\u0003\u0004rest"))).toMatchObject({ ok: true, kind: "docx" });
		expect(classifyAttachment("a.xlsx", bytes("PK\u0003\u0004rest"))).toMatchObject({ ok: true, kind: "xlsx" });
		expect(classifyAttachment("a.zip", bytes("PK\u0003\u0004rest"))).toMatchObject({ ok: true, kind: "zip", mime: "application/zip" });
		expect(classifyAttachment("a.csv", bytes("a,b\n1,2"))).toMatchObject({ ok: true, kind: "csv" });
		expect(classifyAttachment("a.py", bytes("print(1)"))).toMatchObject({ ok: true, kind: "text" });
		expect(classifyAttachment("a.exe", Uint8Array.from([0x4d, 0x5a, 0, 1]))).toMatchObject({ ok: true, kind: "other", mime: "application/octet-stream" });
	});

	it("extensão que promete outro formato é recusada (415)", () => {
		expect(classifyAttachment("a.pdf", bytes("nao e pdf"))).toMatchObject({ ok: false, status: 415 });
		expect(classifyAttachment("a.docx", bytes("texto"))).toMatchObject({ ok: false, status: 415 });
		expect(classifyAttachment("a.csv", Uint8Array.from([1, 0, 2]))).toMatchObject({ ok: false, status: 415 });
	});

	it("vazio 400, acima de 20 MB 413, imagem 415", () => {
		expect(classifyAttachment("a.txt", new Uint8Array(0))).toMatchObject({ ok: false, status: 400 });
		expect(classifyAttachment("a.bin", new Uint8Array(ATTACHMENT_LIMITS.maxBytes + 1))).toMatchObject({ ok: false, status: 413 });
		expect(classifyAttachment("a.bin", new Uint8Array(ATTACHMENT_LIMITS.maxBytes))).toMatchObject({ ok: true });
		expect(classifyAttachment("foto.png", PNG)).toMatchObject({ ok: false, status: 415 });
	});

	it("tipos ativos (html, svg, xml, js) nunca guardam MIME renderizável", () => {
		for (const name of ["p.html", "d.svg", "d.xml", "s.js"]) {
			const verdict = classifyAttachment(name, bytes("<x onload=1>"));
			expect(verdict).toMatchObject({ ok: true, mime: "application/octet-stream" });
		}
	});

	it("nome sanitizado: sem caminho, controles nem pontos iniciais", () => {
		const verdict = classifyAttachment("..\..\pasta/.segredo\u0007.txt", bytes("oi"));
		expect(verdict.ok && verdict.filename).toBe("segredo.txt");
	});

	it("limites: 20 MB por arquivo, 5 por mensagem", () => {
		expect(ATTACHMENT_LIMITS.maxBytes).toBe(20 * 1024 * 1024);
		expect(ATTACHMENT_LIMITS.maxPerMessage).toBe(5);
	});
});

describe("supportsNativePdf por provedor", () => {
	it("Anthropic direto e famílias nativas do OpenRouter leem PDF; ChatGPT, OpenCode Go e o resto vão em texto", () => {
		expect(supportsNativePdf("anthropic-direct/claude-sonnet-4-5")).toBe(true);
		expect(supportsNativePdf("anthropic/claude-sonnet-4.5")).toBe(true);
		expect(supportsNativePdf("openai/gpt-5")).toBe(true);
		expect(supportsNativePdf("google/gemini-2.5-pro")).toBe(true);
		expect(supportsNativePdf("chatgpt/gpt-5")).toBe(false);
		expect(supportsNativePdf("opencode-go/glm-4.6")).toBe(false);
		expect(supportsNativePdf("deepseek/deepseek-chat")).toBe(false);
		expect(supportsNativePdf("")).toBe(false);
	});
});

describe("tipos e cartão", () => {
	it("attachmentKindOf e ícone de arquivo compactado", () => {
		expect(attachmentKindOf("x.zip", "application/zip")).toBe("zip");
		expect(attachmentKindOf("x.bin", "application/octet-stream")).toBe("other");
		expect(attachmentKindOf("x.tsv", "text/tab-separated-values")).toBe("csv");
		expect(fileCategory("x.zip")).toBe("archive");
	});

	it("cartão de arquivo do usuário mantém a origem; o do agente não tem", () => {
		const base = { v: 1, kind: "file", artifactId: "a1", filename: "r.pdf", mime: "application/pdf", size: 10, format: "pdf", version: 1 };
		expect(parseConversationCard(JSON.stringify({ ...base, origin: "user" }))).toMatchObject({ origin: "user" });
		expect(parseConversationCard(JSON.stringify(base))).not.toHaveProperty("origin");
		expect(parseConversationCard(JSON.stringify({ ...base, origin: "alguem" }))).not.toHaveProperty("origin");
	});
});
