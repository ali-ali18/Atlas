import { describe, expect, it } from "vitest";
import { approvalEventFact, approvalMessageFact, formatApprovalEventWhen } from "./index.js";

describe("approvalEventFact", () => {
	it("lê o evento, limita convidados e ignora tipo errado", () => {
		expect(approvalEventFact({ event: { action: "delete", title: " Reunião ", start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", timeZone: "America/Sao_Paulo", guests: ["a@x.com", 5, "b@x.com"], notifyGuests: false } })).toEqual({
			action: "delete",
			title: "Reunião",
			start: "2026-11-05T17:00:00.000Z",
			end: "2026-11-05T18:00:00.000Z",
			allDay: false,
			timeZone: "America/Sao_Paulo",
			guests: ["a@x.com", "b@x.com"],
			notifyGuests: false,
		});
		expect(approvalEventFact({ event: { action: "explode" } })).toBeNull();
		expect(approvalEventFact({ event: [] })).toBeNull();
		expect(approvalEventFact({})).toBeNull();
		expect(approvalEventFact({ event: { action: "delete" } })).toEqual({ action: "delete", allDay: false, guests: [] });
	});
});

describe("formatApprovalEventWhen", () => {
	const base = { start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", allDay: false, timeZone: "America/Sao_Paulo" };
	it("mostra o horário no fuso do evento e no idioma", () => {
		expect(formatApprovalEventWhen(base, "pt-BR")).toMatch(/14:00.*15:00/);
		expect(formatApprovalEventWhen({ ...base, timeZone: "UTC" }, "pt-BR")).toMatch(/17:00.*18:00/);
		expect(formatApprovalEventWhen(base, "en-US")).toMatch(/Nov/);
	});
	it("dia inteiro: o fim é exclusivo e não depende do fuso", () => {
		const one = formatApprovalEventWhen({ start: "2026-11-15", end: "2026-11-16", allDay: true }, "pt-BR");
		expect(one).toContain("15");
		expect(one).not.toContain("16");
		expect(formatApprovalEventWhen({ start: "2026-11-15", end: "2026-11-18", allDay: true }, "pt-BR")).toMatch(/15.*17/);
	});
	it("sem horário legível devolve null; fuso inválido não quebra", () => {
		expect(formatApprovalEventWhen({ allDay: false }, "pt-BR")).toBeNull();
		expect(formatApprovalEventWhen({ start: "lixo", allDay: false }, "pt-BR")).toBeNull();
		expect(formatApprovalEventWhen({ ...base, timeZone: "Marte/Olimpo" }, "pt-BR")).toMatch(/\d{2}:\d{2}/);
	});
});

describe("approvalMessageFact", () => {
	it("traz assunto e corpo inteiro, sem campos internos", () => {
		expect(approvalMessageFact({ message: { subject: "Oi", body: "Linha 1\nLinha 2", from: "gmail", reply: true, source: "gmail", in_reply_to: "m1" } })).toEqual({ subject: "Oi", body: "Linha 1\nLinha 2", from: "gmail", reply: true });
	});
	it("sem corpo ou malformado: null", () => {
		expect(approvalMessageFact({ message: { subject: "x", body: "  " } })).toBeNull();
		expect(approvalMessageFact({ message: "texto" })).toBeNull();
		expect(approvalMessageFact({})).toBeNull();
	});
});
