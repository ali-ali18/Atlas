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
			for (const lang of BOT_LANGUAGES) expect(COPY[id][lang].trim().length).toBeGreaterThanOrEqual(5);
		}
	});

	it("nenhum texto expõe interno (nome de tool em snake_case, campo, id, JSON) nem dado do dono", () => {
		for (const id of ids)
			for (const lang of BOT_LANGUAGES) {
				// `{nome}` é marcador de `copyFor`, não vazamento: sai antes de procurar chaves soltas.
				const text = COPY[id][lang].replace(/\{\w+\}/g, "X");
				expect(text, `${id}/${lang}`).not.toMatch(/\b[a-z]+(?:_[a-z0-9]+)+\b/);
				expect(text, `${id}/${lang}`).not.toMatch(/[{}<>]|\bcall(?:Id)?\b|\bhandoff\b|\bpayload\b|\buserId\b/i);
				expect(scanText(text)).toEqual([]);
			}
	});

	it("marcadores {nome} são trocados e os textos do adaptador de modelo não usam vocabulário interno (auditoria F1, A1)", () => {
		expect(copyFor("en-US", "model_switched", { from: "a/x", to: "b/y", reason: "r" })).toBe("I switched from a/x to b/y because r.");
		for (const id of ["model_none", "models_unavailable", "spend_ceiling", "model_switched", "reason_rate_limit", "reason_quota", "reason_down"] as const)
			for (const lang of BOT_LANGUAGES) expect(COPY[id][lang], `${id}/${lang}`).not.toMatch(/cadeia|papel|chain|role|cadena|\bUS\$/i);
	});

	it("lembrete entregue pela própria nota diz o lembrete nos três idiomas, sem internals (auditoria F4, C1/B2)", () => {
		expect(copyFor("pt-BR", "agenda_reminder_note", { note: "Pagar o condomínio" })).toBe("Lembrete: Pagar o condomínio");
		expect(copyFor("en-US", "agenda_reminder_note", { note: "Pay the rent" })).toBe("Reminder: Pay the rent");
		expect(copyFor("es-ES", "agenda_reminder_note", { note: "Pagar el alquiler" })).toBe("Recordatorio: Pagar el alquiler");
	});

	it("o texto muda com o idioma", () => {
		// "semanal" é a mesma palavra em pt-BR e es-ES.
		for (const id of ids.filter((i) => i !== "ceiling_week")) expect(new Set(BOT_LANGUAGES.map((l) => COPY[id][l])).size).toBe(BOT_LANGUAGES.length);
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
