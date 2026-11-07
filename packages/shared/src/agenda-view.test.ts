import { describe, expect, it } from "vitest";
import { AGENDA_VIEW_MESSAGE_MAX_CHARS, parseAgendaChangeBody, toAgendaItemView, type AgendaViewSource } from "./agenda-view.js";

const base: AgendaViewSource = {
	id: "i1",
	botId: "b1",
	kind: "remind",
	status: "pending",
	note: "Ligar para a Dra. Paula",
	dueAt: new Date("2026-11-08T13:00:00.000Z"),
	intervalMinutes: null,
	untilAt: null,
	maxRuns: null,
	runCount: 0,
	eventFilter: null,
	lastResult: null,
	endReason: null,
	createdAt: new Date("2026-11-07T12:00:00.000Z"),
};

describe("toAgendaItemView", () => {
	it("item ativo tem próxima vez e nenhum motivo de fim", () => {
		const view = toAgendaItemView(base);
		expect(view.nextAt).toBe("2026-11-08T13:00:00.000Z");
		expect(view.endReason).toBeNull();
	});

	it("não vaza campos internos", () => {
		const keys = Object.keys(toAgendaItemView({ ...base, runId: "run-secreto", grant: { autonomy: "balanced", rules: [] }, userId: "u1" } as AgendaViewSource));
		expect(keys).not.toContain("runId");
		expect(keys).not.toContain("grant");
		expect(keys).not.toContain("userId");
	});

	it("intenção por evento não tem horário: vale até a vigência e mostra o filtro", () => {
		const view = toAgendaItemView({ ...base, kind: "intent", untilAt: new Date("2026-12-01T00:00:00.000Z"), eventFilter: { source: "email", from: "loja@exemplo.com", hasAttachment: true } });
		expect(view.nextAt).toBeNull();
		expect(view.untilAt).toBe("2026-12-01T00:00:00.000Z");
		expect(view.event).toEqual({ from: "loja@exemplo.com", hasAttachment: true });
	});

	it("encerrado: sem próxima vez, com o motivo; motivo desconhecido vira other", () => {
		expect(toAgendaItemView({ ...base, status: "done", endReason: "max_runs" })).toMatchObject({ nextAt: null, endReason: "max_runs" });
		expect(toAgendaItemView({ ...base, status: "cancelled", endReason: "owner" }).endReason).toBe("owner");
		expect(toAgendaItemView({ ...base, status: "done", endReason: "algo-novo" }).endReason).toBe("other");
		expect(toAgendaItemView({ ...base, status: "done", endReason: null }).endReason).toBeNull();
	});

	it("pausado mantém a próxima vez e esconde o motivo", () => {
		const view = toAgendaItemView({ ...base, status: "paused", endReason: "owner" });
		expect(view.nextAt).not.toBeNull();
		expect(view.endReason).toBeNull();
	});

	it("última novidade: aparada, cortada no teto, e 'missing' some", () => {
		const long = "x".repeat(AGENDA_VIEW_MESSAGE_MAX_CHARS + 50);
		const view = toAgendaItemView({ ...base, lastResult: { outcome: "update", at: "2026-11-07T15:00:00.000Z", message: `  ${long}  ` } });
		expect(view.lastUpdate?.message?.length).toBe(AGENDA_VIEW_MESSAGE_MAX_CHARS);
		expect(view.lastUpdate?.message?.endsWith("…")).toBe(true);
		expect(toAgendaItemView({ ...base, lastResult: { outcome: "no_change", at: "2026-11-07T15:00:00.000Z" } }).lastUpdate).toEqual({ outcome: "no_change", at: "2026-11-07T15:00:00.000Z", message: null });
		expect(toAgendaItemView({ ...base, lastResult: { outcome: "missing", at: "2026-11-07T15:00:00.000Z" } }).lastUpdate).toBeNull();
	});
});

describe("parseAgendaChangeBody", () => {
	it("aceita as três ações", () => {
		for (const action of ["pause", "resume", "cancel"]) expect(parseAgendaChangeBody({ action })).toEqual({ ok: true, action });
	});
	it("recusa campo desconhecido, ação inválida e corpo que não é objeto", () => {
		expect(parseAgendaChangeBody({ action: "pause", userId: "outro" }).ok).toBe(false);
		expect(parseAgendaChangeBody({ action: "delete" }).ok).toBe(false);
		expect(parseAgendaChangeBody({}).ok).toBe(false);
		expect(parseAgendaChangeBody(null).ok).toBe(false);
		expect(parseAgendaChangeBody([]).ok).toBe(false);
	});
});
