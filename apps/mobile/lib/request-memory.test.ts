import { beforeEach, describe, expect, it } from "vitest";
import { initialStepState } from "./questionnaire";
import { clearQuestionnaireDraft, clearRequestMemory, getQuestionnaireDraft, isSecretsStored, markSecretsStored, setQuestionnaireDraft } from "./request-memory";
import { secretsView } from "./request-cards";

beforeEach(() => clearRequestMemory());

describe("memória dos cartões (fora da linha)", () => {
	it("o passo do questionário volta depois de a linha desmontar, por id, e some ao enviar", () => {
		expect(getQuestionnaireDraft("q1")).toBeUndefined();
		const state = { ...initialStepState(), index: 2, selected: { a: ["x"] }, free: { c: "oi" } };
		setQuestionnaireDraft("q1", state);
		expect(getQuestionnaireDraft("q1")).toEqual(state);
		expect(getQuestionnaireDraft("q2")).toBeUndefined();
		clearQuestionnaireDraft("q1");
		expect(getQuestionnaireDraft("q1")).toBeUndefined();
	});
	it("sair da conta apaga tudo; a memória tem teto", () => {
		setQuestionnaireDraft("q1", initialStepState());
		markSecretsStored("k1");
		clearRequestMemory();
		expect(getQuestionnaireDraft("q1")).toBeUndefined();
		expect(isSecretsStored("k1")).toBe(false);
		for (let i = 0; i < 80; i += 1) setQuestionnaireDraft(`q${i}`, initialStepState());
		expect(getQuestionnaireDraft("q0")).toBeUndefined();
		expect(getQuestionnaireDraft("q79")).toBeDefined();
	});
	it("segredo guardado no Cofre mas decide falhou: mostra \"tentar de novo\" sem pedir o valor de novo", () => {
		expect(secretsView("pending", isSecretsStored("k1"))).toBe("form");
		markSecretsStored("k1");
		expect(secretsView("pending", isSecretsStored("k1"))).toBe("retry");
		expect(secretsView("approved", true)).toBe("resolved");
		expect(secretsView("rejected", false)).toBe("resolved");
	});
});
