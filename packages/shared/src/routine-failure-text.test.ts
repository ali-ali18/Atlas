import { describe, expect, it } from "vitest";
import { describeRoutineFailure, formatRoutineFailurePush, formatRoutineRunReason } from "./index.js";

describe("describeRoutineFailure", () => {
	it("erro cru de crédito do provedor vira texto amigável", () => {
		const raw = "Falha após 3 tentativas: This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 3000.";
		expect(describeRoutineFailure(raw)).toEqual({ kind: "credits", headline: "Sem créditos no provedor do modelo" });
	});

	it("reconhece limite, chave, timeout, provedor fora e rede", () => {
		expect(describeRoutineFailure("HTTP 429 Too Many Requests").kind).toBe("rate_limit");
		expect(describeRoutineFailure("401 Unauthorized: invalid api key").kind).toBe("auth");
		expect(describeRoutineFailure("request timed out").kind).toBe("timeout");
		expect(describeRoutineFailure("Provider returned error: status 503").kind).toBe("provider_down");
		expect(describeRoutineFailure("TypeError: fetch failed (ECONNRESET)").kind).toBe("network");
		expect(describeRoutineFailure("maximum context length exceeded").kind).toBe("context");
	});

	it("texto em pt-BR do próprio sistema passa, só a primeira linha e curto", () => {
		expect(describeRoutineFailure("Rotina pausada")).toEqual({ kind: "text", headline: "Rotina pausada" });
		const long = `Página apagada ${"x".repeat(300)}\nsegunda linha`;
		const { headline } = describeRoutineFailure(long);
		expect(headline.length).toBeLessThanOrEqual(120);
		expect(headline.endsWith("…")).toBe(true);
	});

	it("inglês desconhecido, vazio ou nulo vira erro inesperado, sem vazar o texto", () => {
		expect(describeRoutineFailure("TypeError: Cannot read properties of undefined")).toEqual({ kind: "unknown", headline: "Erro inesperado" });
		expect(describeRoutineFailure("")).toEqual({ kind: "unknown", headline: "Erro inesperado" });
		expect(describeRoutineFailure(null).kind).toBe("unknown");
	});

	it("nunca devolve token que estava no erro", () => {
		const raw = "Rotina falhou com Bearer abcdefghijklmnopqrstuvwxyz0123 e ghp_abcdefghijklmnopqrstuvwxyz0123456";
		const { headline } = describeRoutineFailure(raw);
		expect(headline).not.toMatch(/abcdefghijkl|ghp_/);
	});
});

describe("formatRoutineRunReason / formatRoutineFailurePush", () => {
	it("motivo curto para o histórico", () => {
		expect(formatRoutineRunReason("This request requires more credits")).toBe("sem créditos no provedor do modelo");
	});

	it("push com o nome da rotina", () => {
		expect(formatRoutineFailurePush({ routineName: "Estoque da canela", error: "402 more credits needed" })).toBe(
			"Sem créditos no provedor do modelo — a rotina Estoque da canela não rodou",
		);
		expect(formatRoutineFailurePush({ routineName: "  ", error: undefined })).toBe("Erro inesperado — a rotina sem nome não rodou");
	});
});
