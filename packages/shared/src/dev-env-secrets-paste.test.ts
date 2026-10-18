import { describe, expect, it } from "vitest";
import { isMaskedSecretValue, normalizeEnvText, parseEnvPaste } from "./dev-env-secrets-paste.js";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF = CR + LF;
const pairs = (text: string) => parseEnvPaste(text).entries.map((e) => [e.name, e.value]);

describe("parseEnvPaste (tabela .env)", () => {
	const table: Array<[string, string, string[][]]> = [
		["simples", "A=1", [["A", "1"]]],
		["CRLF do celular", ["A=1", "B=2"].join(CRLF), [["A", "1"], ["B", "2"]]],
		["CR sozinho", ["A=1", "B=2"].join(CR), [["A", "1"], ["B", "2"]]],
		["CRLF no fim do arquivo", "A=1" + CRLF, [["A", "1"]]],
		["export", "export A=1", [["A", "1"]]],
		["export com tab", "export" + String.fromCharCode(9) + "A=1", [["A", "1"]]],
		["comentários e linhas em branco", ["# c", "", "  # d", "A=1"].join(LF), [["A", "1"]]],
		["aspas duplas", 'A="x y"', [["A", "x y"]]],
		["aspas simples", "A='x y'", [["A", "x y"]]],
		["aspas curvas do iOS", "A=“x y”", [["A", "x y"]]],
		["comentário depois do valor entre aspas", 'A="x y" # nota', [["A", "x y"]]],
		["sem aspas mantém o #", "A=abc#def", [["A", "abc#def"]]],
		["= dentro do valor", "A=a=b==", [["A", "a=b=="]]],
		["espaços ao redor do =", "A = 1", [["A", "1"]]],
		["minúsculas", "my_key=abc", [["my_key", "abc"]]],
		["BOM no começo", String.fromCharCode(0xfeff) + "A=1", [["A", "1"]]],
		["valor vazio é ignorado", ["A=", "B=2"].join(LF), [["B", "2"]]],
		["aspas vazias são ignoradas", 'A=""', []],
		["repetido: vale o último", ["A=1", "B=2", "A=3"].join(LF), [["B", "2"], ["A", "3"]]],
		["valor entre aspas em várias linhas", ["KEY=\"-----BEGIN", "abc", "-----END\"", "B=2"].join(CRLF), [["KEY", "-----BEGIN" + LF + "abc" + LF + "-----END"], ["B", "2"]]],
	];
	for (const [label, text, expected] of table) {
		it(label, () => {
			const r = parseEnvPaste(text);
			expect(r.errors).toEqual([]);
			expect(pairs(text)).toEqual(expected);
		});
	}

	it("vazios ficam em `empty`, sem erro", () => {
		const r = parseEnvPaste(["A=", "B=2", "C=''"].join(LF));
		expect(r.empty).toEqual(["A", "C"]);
		expect(r.errors).toEqual([]);
	});
	it("erros por linha: sem '=', nome inválido, reservado, aspas abertas", () => {
		const r = parseEnvPaste(["ok=1", "semigual", "1X=a", "PATH=x", 'Z="aberta'].join(LF));
		expect(r.entries.map((e) => e.name)).toEqual(["ok"]);
		expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
	});
	it("normalizeEnvText", () => {
		expect(normalizeEnvText("a" + CRLF + "b" + CR + "c")).toBe(["a", "b", "c"].join(LF));
	});
});

describe("isMaskedSecretValue", () => {
	it("só bolinhas contam como máscara", () => {
		expect(isMaskedSecretValue("••••••")).toBe(true);
		expect(isMaskedSecretValue("●●●")).toBe(true);
		expect(isMaskedSecretValue("••")).toBe(false);
		expect(isMaskedSecretValue("senha•••")).toBe(false);
		expect(isMaskedSecretValue("****")).toBe(false);
	});
});
