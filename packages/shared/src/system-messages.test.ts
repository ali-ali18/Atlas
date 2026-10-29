import { describe, expect, it } from "vitest";
import { BOT_LANGUAGES } from "./bot-language.js";
import { formatLimitDuration, formatUsd, isSystemMessage, SYSTEM_MESSAGES, systemMessages } from "./system-messages.js";

describe("mensagens de sistema por idioma", () => {
	it("todo idioma suportado tem o dicionário completo (idioma novo exige a entrada)", () => {
		const keys = Object.keys(SYSTEM_MESSAGES["pt-BR"]).sort();
		for (const language of BOT_LANGUAGES) {
			expect(Object.keys(systemMessages(language)).sort()).toEqual(keys);
			expect(Object.keys(systemMessages(language).runErrors).sort()).toEqual(Object.keys(SYSTEM_MESSAGES["pt-BR"].runErrors).sort());
		}
	});

	it("pt-BR mantém o texto de antes", () => {
		const pt = systemMessages("pt-BR");
		expect(pt.stopFallback("o tempo acabou")).toBe('Parei porque o tempo acabou. O que já foi feito ficou salvo nesta conversa. Responda "continuar" que eu retomo de onde parei.');
		expect(pt.stepLimit(30)).toBe("limite de 30 passos esgotado");
		expect(pt.tokenLimit(1000)).toBe("limite de 1000 tokens do run esgotado");
		expect(pt.costCap(formatUsd("pt-BR", 0.5))).toBe("custo máximo da execução atingido (US$ 0,50)");
		expect(pt.wallLimit(formatLimitDuration(30 * 60_000))).toBe("tempo máximo do run esgotado (30 min)");
		expect(pt.autoContinueStatus).toBe("Retomando automaticamente…");
		expect(pt.repeatedWithoutProgress("navigate")).toBe("Travei repetindo navigate com o mesmo resultado, sem progresso.");
	});

	it("en-US e es-ES saem no idioma, sem português no inglês", () => {
		const en = systemMessages("en-US");
		expect(en.stopFallback("the limit of 5 steps was reached")).toContain("I stopped because the limit of 5 steps was reached.");
		expect(en.costCap(formatUsd("en-US", 0.5))).toBe("the run's maximum cost was reached ($0.50)");
		expect(en.stepLimit(12)).toBe("the limit of 12 steps was reached");
		const es = systemMessages("es-ES");
		expect(es.stopFallback("x")).toMatch(/^Me detuve porque x\./);
		expect(es.costCap(formatUsd("es-ES", 0.5))).toBe("se alcanzó el coste máximo de la ejecución (US$ 0,50)");
		const noPortuguese = /\b(parei|limite|passos|tempo|execução|conversa)\b|Responda/i;
		for (const text of [...Object.values(en).filter((value): value is string => typeof value === "string"), ...Object.values(en.runErrors)]) {
			expect(text).not.toMatch(noPortuguese);
		}
	});

	it("contexto cheio: números no formato do idioma e modelo opcional", () => {
		const input = { tokens: (123456).toLocaleString("en-US"), percent: 95, window: (128000).toLocaleString("en-US"), model: "m/x" };
		expect(systemMessages("en-US").contextLimit(input)).toBe('Context estimated at ~123,456 tokens (>95% of the 128,000-token window of model m/x). Summarize the conversation ("Resumir agora") or use a model with a larger window and try again.');
		expect(systemMessages("pt-BR").contextLimit({ ...input, tokens: (123456).toLocaleString("pt-BR"), window: (128000).toLocaleString("pt-BR"), model: undefined })).toContain("~123.456 tokens (>95% da janela de 128.000)");
	});

	it("formata duração e dólar", () => {
		expect(formatLimitDuration(45_000)).toBe("45s");
		expect(formatLimitDuration(5 * 60_000)).toBe("5 min");
		expect(formatUsd("pt-BR", 0.25)).toBe("0,25");
		expect(formatUsd("en-US", 0.25)).toBe("0.25");
		expect(formatUsd("es-ES", 1234.5)).toBe("1234,50");
	});

	it("reconhece o texto de sistema de qualquer idioma (para o tradutor de erros deixar passar)", () => {
		for (const language of BOT_LANGUAGES) {
			const messages = systemMessages(language);
			for (const text of [messages.noProgress, messages.readingWithoutFile, messages.truncatedToolCall, messages.repeatedWithoutProgress("web_search")]) {
				expect(isSystemMessage(text), text).toBe(true);
			}
		}
		expect(isSystemMessage("Something went wrong with a provider")).toBe(false);
		expect(isSystemMessage("")).toBe(false);
	});
});
