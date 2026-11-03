import { describe, expect, it } from "vitest";
import { base64Encode, csvToTable, decodeUtf8, detectDelimiter, documentViewKind, imageDataUri, pageShareMessage, parseCsv, prettyJson, truncateForShare } from "./document-view";

const bytes = (...values: number[]) => new Uint8Array(values);
const encode = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

describe("como abrir o arquivo", () => {
	it("markdown, texto, csv e json pelo mime", () => {
		expect(documentViewKind("text/markdown", "a.md")).toBe("markdown");
		expect(documentViewKind("text/markdown; charset=utf-8", "a")).toBe("markdown");
		expect(documentViewKind("text/plain", "notas.txt")).toBe("text");
		expect(documentViewKind("text/csv", "dados.csv")).toBe("csv");
		expect(documentViewKind("application/json", "x.json")).toBe("json");
		expect(documentViewKind("application/vnd.api+json", "x")).toBe("json");
	});
	it("text/plain com extensão de markdown ou código usa a extensão", () => {
		expect(documentViewKind("text/plain", "vm-instalar-apps.md")).toBe("markdown");
		expect(documentViewKind("text/plain", "script.py")).toBe("code");
		expect(documentViewKind("text/plain", "foto.png")).toBe("text");
	});
	it("código-fonte", () => {
		expect(documentViewKind("application/javascript", "a.js")).toBe("code");
		expect(documentViewKind("text/x-python", "a.py")).toBe("code");
		expect(documentViewKind("text/html", "a.html")).toBe("code");
		expect(documentViewKind("application/octet-stream", "main.ts")).toBe("code");
	});
	it("mime genérico ou vazio cai na extensão", () => {
		expect(documentViewKind("application/octet-stream", "leia-me.md")).toBe("markdown");
		expect(documentViewKind("", "dados.CSV")).toBe("csv");
		expect(documentViewKind("", "arquivo.xyz")).toBe("unsupported");
	});
	it("imagens raster são imagem; SVG nunca (pode ter script): vira código", () => {
		for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(documentViewKind(mime, "x")).toBe("image");
		expect(documentViewKind("image/svg+xml", "logo.svg")).toBe("code");
	});
	it("PDF, Office e binários não têm visualizador (mesmo com extensão enganosa de texto)", () => {
		expect(documentViewKind("application/pdf", "a.pdf")).toBe("unsupported");
		expect(documentViewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("unsupported");
		expect(documentViewKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx")).toBe("unsupported");
		expect(documentViewKind("application/vnd.openxmlformats-officedocument.presentationml.presentation", "a.pptx")).toBe("unsupported");
		expect(documentViewKind("application/zip", "notas.md")).toBe("unsupported");
		expect(documentViewKind("application/pdf", "relatorio.md")).toBe("unsupported");
	});
});

describe("decodificação UTF-8", () => {
	it("acentos, emoji e BOM", () => {
		expect(decodeUtf8(encode("Instalação ✓ 😀"))).toBe("Instalação ✓ 😀");
		expect(decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe("a");
	});
	it("bytes inválidos viram U+FFFD sem perder o resto", () => {
		expect(decodeUtf8(bytes(0x61, 0xff, 0x62))).toBe("a�b");
		expect(decodeUtf8(bytes(0xe2, 0x82))).toBe("��");
		expect(decodeUtf8(bytes(0xc0, 0x80))).toBe("��");
		expect(decodeUtf8(bytes(0xed, 0xa0, 0x80))).toBe("�");
	});
	it("vazio e texto grande (passa do bloco interno)", () => {
		expect(decodeUtf8(new Uint8Array())).toBe("");
		const big = "é".repeat(20000);
		expect(decodeUtf8(encode(big))).toBe(big);
	});
});

describe("base64 e imagem", () => {
	it("bate com o base64 do Node, com e sem preenchimento", () => {
		for (const text of ["", "a", "ab", "abc", "abcd", "Instalação"]) expect(base64Encode(encode(text))).toBe(Buffer.from(text, "utf8").toString("base64"));
	});
	it("data URI só com mime raster conhecido", () => {
		expect(imageDataUri("image/jpeg", bytes(1, 2, 3))).toBe("data:image/jpeg;base64,AQID");
		expect(imageDataUri("image/jpg", bytes(1))).toMatch(/^data:image\/jpeg;/);
		expect(imageDataUri("text/html", bytes(1))).toMatch(/^data:image\/png;/);
	});
});

describe("corte para compartilhar", () => {
	it("texto curto passa inteiro", () => {
		expect(truncateForShare("abc", 10)).toEqual({ text: "abc", truncated: false });
	});
	it("texto grande é cortado e marcado", () => {
		const result = truncateForShare("a".repeat(50), 10);
		expect(result.truncated).toBe(true);
		expect(result.text).toBe(`${"a".repeat(10)}\n…`);
	});
	it("não parte um par substituto no corte", () => {
		const result = truncateForShare("a😀b", 2);
		expect(result.text).toBe("a\n…");
	});
	it("mensagem de painel: título + resumo", () => {
		expect(pageShareMessage("Atlas", " Resumo ")).toBe("Atlas\n\nResumo");
		expect(pageShareMessage("Atlas", "")).toBe("Atlas");
		expect(pageShareMessage("Atlas", null)).toBe("Atlas");
	});
});

describe("CSV", () => {
	it("separador pelo cabeçalho", () => {
		expect(detectDelimiter("a,b,c")).toBe(",");
		expect(detectDelimiter("a;b;c")).toBe(";");
		expect(detectDelimiter("a\tb")).toBe("\t");
		expect(detectDelimiter("")).toBe(",");
	});
	it("aspas, vírgula e quebra de linha dentro do campo, aspas duplas", () => {
		expect(parseCsv('a,b\n"x, y","linha1\nlinha2"\n"diz ""oi""",z\n')).toEqual([["a", "b"], ["x, y", "linha1\nlinha2"], ['diz "oi"', "z"]]);
	});
	it("CRLF, BOM, ponto e vírgula e linhas vazias no fim", () => {
		expect(parseCsv("﻿a;b\r\n1;2\r\n\r\n")).toEqual([["a", "b"], ["1", "2"]]);
		expect(parseCsv("")).toEqual([]);
	});
	it("tabela: cabeçalho, linhas preenchidas até a largura máxima e células em texto puro", () => {
		const table = csvToTable("Tipo,Exemplo,Comando\nApp,**Slack**,https://x.com\nCurto\n");
		expect(table.totalRows).toBe(2);
		expect(table.block?.header.map((cell) => cell[0])).toEqual([{ type: "text", text: "Tipo" }, { type: "text", text: "Exemplo" }, { type: "text", text: "Comando" }]);
		expect(table.block?.rows[0]![1]).toEqual([{ type: "text", text: "**Slack**" }]);
		expect(table.block?.rows[1]).toHaveLength(3);
		expect(table.block?.rows[1]![2]).toEqual([{ type: "text", text: "" }]);
	});
	it("limita as linhas desenhadas e diz o total", () => {
		const csv = ["n", ...Array.from({ length: 10 }, (_, index) => String(index))].join("\n");
		const table = csvToTable(csv, 3);
		expect(table).toMatchObject({ totalRows: 10, shownRows: 3 });
		expect(table.block?.rows).toHaveLength(3);
		expect(csvToTable("")).toEqual({ block: null, totalRows: 0, shownRows: 0 });
	});
});

describe("JSON", () => {
	it("reindenta o válido e mantém o inválido como veio", () => {
		expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
		expect(prettyJson("{quebrado")).toBe("{quebrado");
	});
});
