import { describe, expect, it } from "vitest";
import { splitReplySegments } from "./reply-segments.js";

const FRETE = [
	"```texto",
	"Cotação de frete",
	"",
	"Remetente: Atlas Ltda",
	"",
	"Destinatário: Cliente SA",
	"",
	"Carga: 10 caixas",
	"",
	"Medidas: 50x50x50",
	"```",
].join("\n");

describe("splitReplySegments", () => {
	it("separa parágrafos comuns", () => {
		expect(splitReplySegments("a\n\nb\n\n\n\nc")).toEqual(["a", "b", "c"]);
		expect(splitReplySegments("a\nb\n\nc")).toEqual(["a\nb", "c"]);
	});

	it("mantém bloco cercado com linhas em branco em um só segmento", () => {
		expect(splitReplySegments(FRETE)).toEqual([FRETE]);
	});

	it("texto antes e depois da cerca vira segmentos próprios", () => {
		const text = `Segue a cotação:\n\n${FRETE}\n\nPosso enviar?`;
		expect(splitReplySegments(text)).toEqual([
			"Segue a cotação:",
			FRETE,
			"Posso enviar?",
		]);
	});

	it("aceita cercas com til", () => {
		const block = "~~~\na\n\nb\n~~~";
		expect(splitReplySegments(`x\n\n${block}\n\ny`)).toEqual(["x", block, "y"]);
	});

	it("cerca maior contém cerca menor", () => {
		const block = "````md\n```js\na\n\nb\n```\n\nc\n````";
		expect(splitReplySegments(`${block}\n\nfim`)).toEqual([block, "fim"]);
	});

	it("cerca sem fechamento vai até o fim em um segmento", () => {
		expect(splitReplySegments("oi\n\n```\na\n\nb\n\nc")).toEqual([
			"oi",
			"```\na\n\nb\n\nc",
		]);
	});

	it("vazio ou só espaços retorna []", () => {
		expect(splitReplySegments("")).toEqual([]);
		expect(splitReplySegments(" \n\n \n")).toEqual([]);
	});

	it("aceita CRLF", () => {
		expect(splitReplySegments("a\r\n\r\nb")).toEqual(["a", "b"]);
		expect(splitReplySegments("```\r\na\r\n\r\nb\r\n```")).toEqual([
			"```\na\n\nb\n```",
		]);
	});
});
