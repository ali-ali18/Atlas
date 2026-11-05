import { BOT_LANGUAGES } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { scanText } from "../hygiene.test.js";
import { COPY, COPY_FALLBACK_LANGUAGE, type CopyId, copyFor } from "./copy.js";

const ids = Object.keys(COPY) as CopyId[];

describe("copy: textos ao dono por idioma do bot (F1.11)", () => {
	it("todo id tem todos os idiomas do app, sem texto vazio", () => {
		expect(BOT_LANGUAGES.length).toBeGreaterThanOrEqual(3);
		for (const id of ids) {
			expect(Object.keys(COPY[id]).sort()).toEqual([...BOT_LANGUAGES].sort());
			for (const lang of BOT_LANGUAGES) expect(COPY[id][lang].trim().length).toBeGreaterThan(5);
		}
	});

	it("nenhum texto expõe interno (nome de tool em snake_case, campo, id, JSON) nem dado do dono", () => {
		for (const id of ids)
			for (const lang of BOT_LANGUAGES) {
				const text = COPY[id][lang];
				expect(text, `${id}/${lang}`).not.toMatch(/\b[a-z]+(?:_[a-z0-9]+)+\b/);
				expect(text, `${id}/${lang}`).not.toMatch(/[{}<>]|\bcall(?:Id)?\b|\bhandoff\b|\bpayload\b|\buserId\b/i);
				expect(scanText(text)).toEqual([]);
			}
	});

	it("o texto muda com o idioma", () => {
		for (const id of ids) expect(new Set(BOT_LANGUAGES.map((l) => COPY[id][l])).size).toBe(BOT_LANGUAGES.length);
		expect(copyFor("en-US", "handoff")).toMatch(/yours alone/);
		expect(copyFor("es-ES", "handoff")).toMatch(/solo tuyo/);
		expect(copyFor("pt-BR", "handoff")).toMatch(/só seu/);
	});

	it("idioma ausente, 'auto' ou desconhecido cai no idioma de reserva", () => {
		const fallback = COPY.handoff[COPY_FALLBACK_LANGUAGE];
		for (const lang of [undefined, "auto", "fr-FR", 3]) expect(copyFor(lang, "handoff")).toBe(fallback);
		expect(COPY_FALLBACK_LANGUAGE).toBe("pt-BR");
	});
});
