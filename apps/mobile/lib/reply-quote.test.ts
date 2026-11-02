import { describe, expect, it } from "vitest";
import { parseReplyTo, quoteSnippet, replyQuoteFor, REPLY_SNIPPET_MAX } from "./reply-quote";

describe("quoteSnippet", () => {
	it("texto curto fica como está; quebras e espaços repetidos viram um espaço", () => {
		expect(quoteSnippet("Oi, tudo bem?")).toBe("Oi, tudo bem?");
		expect(quoteSnippet("  linha 1\n\nlinha   2  ")).toBe("linha 1 linha 2");
	});
	it("vazio ou só espaços vira vazio", () => {
		expect(quoteSnippet("")).toBe("");
		expect(quoteSnippet(" \n\t ")).toBe("");
	});
	it("tira o markdown (negrito, título, link, bloco de código) como o servidor", () => {
		expect(quoteSnippet("**1) Agenda de hoje:** só o feriado de Finados")).toBe("1) Agenda de hoje: só o feriado de Finados");
		expect(quoteSnippet("# Título\nveja [o site](https://x.com) e `isto`")).toBe("Título veja o site e isto");
		expect(quoteSnippet("antes\n```js\nconst a = 1\n```\ndepois")).toBe("antes depois");
	});
	it("corta em 160 caracteres, nem mais nem menos", () => {
		expect(quoteSnippet("a".repeat(160))).toHaveLength(160);
		expect(quoteSnippet("a".repeat(161))).toBe("a".repeat(160));
	});
	it("conta emoji como um caractere (não corta um par substituto ao meio)", () => {
		const text = "😀".repeat(REPLY_SNIPPET_MAX + 5);
		const out = quoteSnippet(text);
		expect(Array.from(out)).toHaveLength(REPLY_SNIPPET_MAX);
		expect(out).toBe("😀".repeat(REPLY_SNIPPET_MAX));
	});
	it("acentos e texto com combinação de letras passam inteiros", () => {
		expect(quoteSnippet("Ação é coração")).toBe("Ação é coração");
	});
});

describe("replyQuoteFor", () => {
	it("cita fala gravada do usuário e do bot, com o trecho", () => {
		expect(replyQuoteFor({ id: "m1", kind: "user", text: "Oi\nvocê" })).toEqual({ id: "m1", role: "user", text: "Oi você" });
		expect(replyQuoteFor({ id: "m2", kind: "assistant", text: "x".repeat(300) })).toEqual({ id: "m2", role: "assistant", text: "x".repeat(160) });
	});
	it("não cita balão ainda sem id gravado, cartão ou marcador", () => {
		expect(replyQuoteFor({ id: "msg-1-ab", kind: "user", text: "Oi" })).toBeNull();
		expect(replyQuoteFor({ id: "cu-1", kind: "assistant", text: "Oi" })).toBeNull();
		expect(replyQuoteFor({ id: "k", kind: "marker", text: "Oi" })).toBeNull();
	});
});

describe("parseReplyTo", () => {
	it("aceita o contrato do servidor", () => {
		expect(parseReplyTo({ id: "m1", role: "assistant", text: "Pronto" })).toEqual({ id: "m1", role: "assistant", text: "Pronto" });
	});
	it("ignora o que foge do contrato", () => {
		expect(parseReplyTo(null)).toBeNull();
		expect(parseReplyTo(undefined)).toBeNull();
		expect(parseReplyTo("x")).toBeNull();
		expect(parseReplyTo({ id: "m1", role: "system", text: "x" })).toBeNull();
		expect(parseReplyTo({ id: "", role: "user", text: "x" })).toBeNull();
		expect(parseReplyTo({ id: "m1", role: "user", text: 5 })).toBeNull();
		expect(parseReplyTo({ id: "m1", role: "user", text: "   " })).toBeNull();
	});
});
