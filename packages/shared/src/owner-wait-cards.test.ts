import { describe, expect, it } from "vitest";
import { parseConversationCard, serializeConversationCard } from "./skill-card.js";
import { parseOwnerWaitDeadline, parseStepLimitProgress } from "./owner-wait.js";

/** PR8d: os cartões do "esperar o dono" guardam prazo, desfecho e tipo (antes só vinham pelo SSE e sumiam no reload). */
describe("cartões gravados do esperar o dono", () => {
	const deadline = "2026-11-04T17:30:00.000Z";

	it("confirm guarda deadlineAt, ownerCard e o progresso do limite", () => {
		const card = parseConversationCard(
			JSON.stringify({
				v: 1,
				kind: "confirm",
				confirmId: "confirm-limit1-run1",
				title: "Cheguei no limite de 40 passos. Continuo?",
				status: "pending",
				deadlineAt: deadline,
				ownerCard: "step-limit",
				limitProgress: { steps: 40, costUsd: 0.1234, tasksDone: ["Ler as notas", "  "], tasksTotal: 5 },
			}),
		);
		expect(card).toMatchObject({ kind: "confirm", deadlineAt: deadline, ownerCard: "step-limit", limitProgress: { steps: 40, costUsd: 0.12, tasksDone: ["Ler as notas"], tasksTotal: 5 } });
	});

	it("confirm sem os campos novos continua igual (legado) e lixo é descartado", () => {
		const legacy = parseConversationCard(JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar?", status: "pending" }));
		expect(legacy).toEqual({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar?", status: "pending" });
		const junk = parseConversationCard(JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar?", status: "pending", deadlineAt: "amanhã", ownerCard: "outro", limitProgress: { steps: -1 } }));
		expect(junk).toEqual(legacy);
	});

	it("login guarda outcome só depois de concluído, e o prazo", () => {
		const done = parseConversationCard(JSON.stringify({ v: 1, kind: "login", loginId: "l1", site: "gemini", url: "https://x", status: "done", outcome: "skipped_timeout", deadlineAt: deadline, ownerWait: true }));
		expect(done).toMatchObject({ status: "done", outcome: "skipped_timeout", deadlineAt: deadline, ownerWait: true });
		const pending = parseConversationCard(JSON.stringify({ v: 1, kind: "login", loginId: "l1", site: "gemini", url: "https://x", status: "pending", outcome: "done" }));
		expect(pending && "outcome" in pending).toBe(false);
		const bad = parseConversationCard(JSON.stringify({ v: 1, kind: "login", loginId: "l1", site: "gemini", url: "https://x", status: "done", outcome: "approved" }));
		expect(bad && "outcome" in bad).toBe(false);
	});

	it("questionário guarda o prazo e o Pular do v3", () => {
		const card = parseConversationCard(
			JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: "questionnaire-r1", title: "Qual período?", status: "pending", items: [{ name: "p", prompt: "Qual?", choices: [{ value: "a" }] }], deadlineAt: deadline, ownerWait: true }),
		);
		expect(card).toMatchObject({ deadlineAt: deadline, ownerWait: true });
	});

	it("limites dos parsers", () => {
		expect(parseOwnerWaitDeadline(undefined)).toBeUndefined();
		expect(parseOwnerWaitDeadline("x".repeat(50))).toBeUndefined();
		expect(parseOwnerWaitDeadline("2026-11-04T14:30:00-03:00")).toBe(deadline);
		expect(parseOwnerWaitDeadline("2026-11-04T17:30Z")).toBe(deadline);
		// Auditoria do PR #131: `new Date` aceitava qualquer coisa parecida com data.
		for (const junk of ["1", "Mar 5", "2026-11-04", "2026-11-04T17:30:00", "Wed Nov 04 2026 14:30:00 GMT-0300", "1730741400000"]) {
			expect(parseOwnerWaitDeadline(junk), junk).toBeUndefined();
		}
		expect(parseStepLimitProgress({ steps: 0 })).toEqual({ steps: 0 });
		expect(parseStepLimitProgress({ steps: 1.5 })).toBeUndefined();
		expect(parseStepLimitProgress({ steps: 3, tasksDone: Array.from({ length: 20 }, (_, i) => `t${i}`) })?.tasksDone).toHaveLength(8);
	});
});
