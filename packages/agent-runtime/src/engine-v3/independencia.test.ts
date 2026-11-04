import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Checagem de código-fonte (não de texto de usuário): o motor v3 nasce sem depender do laço v1 (`computer-use.ts`).
const dir = dirname(fileURLToPath(import.meta.url));
const sourceFiles = () => readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const specifiers = (code: string) => [...code.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? match[2] ?? "");

describe("independência do motor v3", () => {
	it("encontra os arquivos do motor v3", () => {
		expect(sourceFiles().length).toBeGreaterThan(8);
	});

	it("sem roteador por regex, carga adiada nem grupos sticky no v3 (a ponte substitui)", () => {
		const banned = /(^|\/)(intent-router|native-deferral|sticky-groups|economy)(\.js)?$/;
		const offenders = sourceFiles().filter((name) => specifiers(readFileSync(join(dir, name), "utf8")).some((specifier) => banned.test(specifier)));
		expect(offenders).toEqual([]);
	});

	it("nenhum arquivo de produção do engine-v3 importa de computer-use", () => {
		const offenders = sourceFiles().filter((name) => specifiers(readFileSync(join(dir, name), "utf8")).some((specifier) => /(^|\/)computer-use(\.js)?$/.test(specifier)));
		expect(offenders).toEqual([]);
	});
});
