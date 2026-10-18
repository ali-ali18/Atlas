import { describe, expect, it } from "vitest";
import {
	QUESTIONNAIRE_ANSWERED_EVENT,
	QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION,
	QUESTIONNAIRE_TASK_ANSWER_INSTRUCTION,
	buildQuestionnaireAnsweredMessages,
	parseQuestionnaireAnsweredContent,
	questionnaireAnswerInstruction,
} from "./questionnaire.js";

describe("questionnaireAnswerInstruction (seleção por purpose)", () => {
	it("purpose onboarding usa a instrução de onboarding (fluxo de config do bot)", () => {
		expect(
			questionnaireAnswerInstruction({ purpose: "onboarding" }),
		).toBe(QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION);
	});

	it("purpose task usa a instrução de tarefa e embute o pedido original", () => {
		const instruction = questionnaireAnswerInstruction({
			purpose: "task",
			originalRequest: "me lembra de dar deploy dia 03/10 pelo chat",
		});
		expect(instruction).toBe(
			QUESTIONNAIRE_TASK_ANSWER_INSTRUCTION(
				"me lembra de dar deploy dia 03/10 pelo chat",
			),
		);
		expect(instruction).toContain(
			"me lembra de dar deploy dia 03/10 pelo chat",
		);
		expect(instruction).toContain("NÃO proponha mudança de perfil");
	});

	it("card legado sem purpose conta como task (nunca assume onboarding)", () => {
		const instruction = questionnaireAnswerInstruction({});
		expect(instruction).toBe(QUESTIONNAIRE_TASK_ANSWER_INSTRUCTION(undefined));
		expect(instruction).not.toBe(QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION);
	});

	it("instrução de tarefa nunca é igual à de onboarding (nem sem pedido original)", () => {
		expect(QUESTIONNAIRE_TASK_ANSWER_INSTRUCTION()).not.toBe(
			QUESTIONNAIRE_ONBOARDING_ANSWER_INSTRUCTION,
		);
	});
});

describe("buildQuestionnaireAnsweredMessages (purpose + originalRequest no JSON)", () => {
	it("embute purpose e originalRequest no payload do user", () => {
		const [, userMessage] = buildQuestionnaireAnsweredMessages({
			systemInstruction: "system",
			questionnaireId: "q-1",
			answers: { canal: "chat" },
			submittedAt: "2026-09-28T00:00:00.000Z",
			purpose: "task",
			originalRequest: "me lembra de dar deploy dia 03/10 pelo chat",
		});
		const payload = JSON.parse(userMessage!.content);
		expect(payload).toMatchObject({
			questionnaireId: "q-1",
			event: QUESTIONNAIRE_ANSWERED_EVENT,
			purpose: "task",
			originalRequest: "me lembra de dar deploy dia 03/10 pelo chat",
		});
	});

	it("sem purpose/originalRequest não grava os campos (card legado)", () => {
		const [, userMessage] = buildQuestionnaireAnsweredMessages({
			systemInstruction: "system",
			questionnaireId: "q-1",
			answers: { canal: "chat" },
			submittedAt: "2026-09-28T00:00:00.000Z",
		});
		const payload = JSON.parse(userMessage!.content);
		expect(payload.purpose).toBeUndefined();
		expect(payload.originalRequest).toBeUndefined();
	});
});

describe("parseQuestionnaireAnsweredContent", () => {
	it("faz round trip do payload construído por buildQuestionnaireAnsweredMessages", () => {
		const [, userMessage] = buildQuestionnaireAnsweredMessages({
			systemInstruction: "system",
			questionnaireId: "q-1",
			answers: { canal: "chat" },
			submittedAt: "2026-09-28T00:00:00.000Z",
			purpose: "onboarding",
			originalRequest: "pedido original",
		});
		expect(parseQuestionnaireAnsweredContent(userMessage!.content)).toEqual({
			questionnaireId: "q-1",
			event: QUESTIONNAIRE_ANSWERED_EVENT,
			answers: { canal: "chat" },
			submittedAt: "2026-09-28T00:00:00.000Z",
			purpose: "onboarding",
			originalRequest: "pedido original",
		});
	});

	it("retorna null para conteúdo que não é o evento questionnaire-answered", () => {
		expect(parseQuestionnaireAnsweredContent("me lembra às 10h")).toBeNull();
		expect(
			parseQuestionnaireAnsweredContent(
				JSON.stringify({ event: "questionnaire-submitted" }),
			),
		).toBeNull();
		expect(parseQuestionnaireAnsweredContent("not json")).toBeNull();
	});
});
