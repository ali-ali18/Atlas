import { describe, expect, it } from "vitest";
import {
	draftDecisionsNote,
	OWNER_WAIT_CARD_DETAIL,
	OWNER_WAIT_OUTCOMES,
	SCHEDULE_RETURN_MAX_PENDING,
	formatReturnMarker,
	isRefusedOutcome,
	lateOwnerDecisionNote,
	ownerWaitResultText,
	ownerWaitTimeoutJobId,
	parseWaitMinutes,
	pendingReturnsNote,
	planScheduleReturn,
	scheduledReturnJobId,
	scheduledReturnPrompt,
} from "./owner-wait.js";

const now = new Date("2026-11-04T12:00:00.000Z");

describe("ownerWaitResultText", () => {
	it("pular não encerra a tarefa: segue com o resto e diz em uma linha o que ficou de fora", () => {
		const text = ownerWaitResultText("skipped", { what: "log in to Gemini" });
		expect(text).toContain("Owner skipped this step");
		expect(text).toContain("Continue the rest of the task without it");
		expect(text).toContain("say in one line what was left out");
		expect(text).toContain("Do not ask for this again in this task");
	});

	it("prazo vencido nunca aprova", () => {
		const text = ownerWaitResultText("skipped_timeout", { what: "share the page", minutes: 30 });
		expect(text).toContain("within 30 min");
		expect(text).toContain("NOT approved");
		expect(text).toContain("Continue the rest of the task without it");
	});

	it("ignorado leva a fala nova do dono como dado", () => {
		const text = ownerWaitResultText("ignored", { what: "log in", message: "  esquece, faz o resumo\n" });
		expect(text).toContain('did not answer the previous request ("log in") and sent: "esquece, faz o resumo"');
	});

	it("terminei manda conferir; assumir manda não mexer na VM", () => {
		expect(ownerWaitResultText("done", { what: "log in" })).toContain("Check the result first");
		expect(ownerWaitResultText("takeover", { what: "log in" })).toContain("Do not use the computer");
	});

	it("toda saída tem texto e rótulo de cartão", () => {
		for (const outcome of OWNER_WAIT_OUTCOMES) {
			expect(ownerWaitResultText(outcome, { what: "x" }).length).toBeGreaterThan(5);
			expect(OWNER_WAIT_CARD_DETAIL[outcome]).toBeTruthy();
		}
		expect(OWNER_WAIT_CARD_DETAIL.ignored).toBe("Dispensado");
		expect(OWNER_WAIT_CARD_DETAIL.skipped_timeout).toBe("Tempo esgotado · segui sem isso");
	});

	it("recusado/pulado/ignorado contam como pedido recusado; feito e aprovado não", () => {
		expect(isRefusedOutcome("declined")).toBe(true);
		expect(isRefusedOutcome("skipped_timeout")).toBe(true);
		expect(isRefusedOutcome("ignored")).toBe(true);
		expect(isRefusedOutcome("done")).toBe(false);
		expect(isRefusedOutcome("approved")).toBe(false);
	});
});

describe("parseWaitMinutes", () => {
	it("ausente = sem prazo; 1 e 1440 valem", () => {
		expect(parseWaitMinutes(undefined)).toEqual({ ok: true });
		expect(parseWaitMinutes(null)).toEqual({ ok: true });
		expect(parseWaitMinutes(1)).toEqual({ ok: true, minutes: 1 });
		expect(parseWaitMinutes(1440)).toEqual({ ok: true, minutes: 1440 });
		expect(parseWaitMinutes("30")).toEqual({ ok: true, minutes: 30 });
	});

	it("fora do intervalo ou fracionado falha com o aceito", () => {
		for (const bad of [0, 1441, 2.5, -3, "abc", true]) {
			const parsed = parseWaitMinutes(bad);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toContain("1 to 1440");
		}
	});
});

describe("lateOwnerDecisionNote", () => {
	it("registra a hora e diz que não é o trabalho atual", () => {
		const note = lateOwnerDecisionNote({ outcome: "declined", what: "Criar um link público do painel", at: now, timeZone: "America/Sao_Paulo" });
		expect(note).toContain("declined an earlier request at 09:00");
		expect(note).toContain("change your plan only if you depended on it");
	});
});

describe("planScheduleReturn", () => {
	it("inMinutes e at com fuso", () => {
		const plan = planScheduleReturn({ inMinutes: 30, reason: "check the deploy", now, pending: 0 });
		expect(plan).toMatchObject({ ok: true, delayMs: 30 * 60_000, visible: false, reason: "check the deploy" });
		const at = planScheduleReturn({ at: "2026-11-04T15:30:00-03:00", reason: "x", visible: true, now, pending: 2 });
		expect(at.ok && at.dueAt.toISOString()).toBe("2026-11-04T18:30:00.000Z");
		expect(at.ok && at.visible).toBe(true);
	});

	it("limites: 1 min a 7 dias, 3 pendentes, um dos dois horários, motivo", () => {
		expect(planScheduleReturn({ inMinutes: 0.5, reason: "x", now, pending: 0 })).toMatchObject({ ok: false });
		expect(planScheduleReturn({ inMinutes: 1, reason: "x", now, pending: 0 }).ok).toBe(true);
		expect(planScheduleReturn({ inMinutes: 7 * 24 * 60, reason: "x", now, pending: 0 }).ok).toBe(true);
		expect(planScheduleReturn({ inMinutes: 7 * 24 * 60 + 1, reason: "x", now, pending: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("routine") });
		expect(planScheduleReturn({ inMinutes: 5, reason: "x", now, pending: SCHEDULE_RETURN_MAX_PENDING })).toMatchObject({ ok: false, error: expect.stringContaining("3 pending") });
		expect(planScheduleReturn({ inMinutes: 5, at: "2026-11-04T15:30:00Z", reason: "x", now, pending: 0 })).toMatchObject({ ok: false });
		expect(planScheduleReturn({ reason: "x", now, pending: 0 })).toMatchObject({ ok: false });
		expect(planScheduleReturn({ inMinutes: 5, reason: "  ", now, pending: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
		expect(planScheduleReturn({ at: "2026-11-04T15:30:00", reason: "x", now, pending: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("offset") });
		expect(planScheduleReturn({ at: "2026-11-04T11:00:00Z", reason: "x", now, pending: 0 })).toMatchObject({ ok: false });
		expect(planScheduleReturn({ inMinutes: 5, reason: "x", visible: "yes", now, pending: 0 })).toMatchObject({ ok: false });
	});
});

describe("marcador e prompt do retorno", () => {
	it("mesmo dia mostra só a hora; outro dia, a data", () => {
		expect(formatReturnMarker(new Date("2026-11-04T18:30:00Z"), now, "America/Sao_Paulo")).toBe("Volto às 15:30");
		expect(formatReturnMarker(new Date("2026-11-05T18:30:00Z"), now, "America/Sao_Paulo")).toBe("Volto em 05/11 às 15:30");
	});

	it("invisível só posta com novidade; visível sempre volta", () => {
		const silent = scheduledReturnPrompt({ reason: "ver o pedido", visible: false, scheduledAt: now, noUpdateToken: "[NO_UPDATE]" });
		expect(silent).toContain("reply exactly [NO_UPDATE]");
		const shown = scheduledReturnPrompt({ reason: "ver o pedido", visible: true, scheduledAt: now, noUpdateToken: "[NO_UPDATE]" });
		expect(shown).not.toContain("[NO_UPDATE]");
		expect(shown).toContain("post the result");
	});

	it("nota de pendentes e ids de job sem ':'", () => {
		expect(pendingReturnsNote([])).toBe("");
		expect(pendingReturnsNote([{ dueAt: now, reason: "x" }])).toContain("Do not schedule the same again");
		expect(ownerWaitTimeoutJobId("confirm-toolabc-run1")).not.toContain(":");
		expect(scheduledReturnJobId("r1")).toBe("return-r1");
	});
});

describe("rascunho descartado ou ignorado (PR8e)", () => {
	it("nota interna curta, com texto próprio para o ignorado; vazia sem rascunho", () => {
		expect(draftDecisionsNote([])).toBe("");
		expect(draftDecisionsNote([{ title: "Trello: update card?", decision: "dismissed" }])).toBe('The owner dismissed draft(s) you left for approval: "Trello: update card". None of them was done. Do not prepare them again unless the owner asks.');
		expect(draftDecisionsNote([{ title: "A?", decision: "ignored" }])).toBe('The owner did not answer the draft(s) you left for approval and sent another message instead: "A". None of them was done. Do not prepare them again unless the owner asks.');
		expect(draftDecisionsNote([{ title: "A?", decision: "dismissed" }, { title: "B?", decision: "ignored" }])).toMatch(/dismissed draft\(s\)[^.]*"A"\. The owner did not answer[^.]*"B"\./);
	});
});
