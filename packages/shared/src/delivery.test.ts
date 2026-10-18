import { describe, expect, it } from "vitest";
import {
	DELIVERY_COALESCE_WINDOW_MS,
	coalesceDeliveries,
	parseDeliverAt,
	planDeliveryDue,
	summarizeDeliveryText,
	wallClockNow,
	type DueDelivery,
} from "./delivery.js";

const NOW = new Date("2026-10-11T02:30:00.000Z"); // 23:30 de 10/10 em São Paulo

describe("wallClockNow", () => {
	it("devolve o horário de parede no fuso", () => {
		expect(wallClockNow(NOW, "America/Sao_Paulo")).toBe("2026-10-10T23:30");
		expect(wallClockNow(NOW, "UTC")).toBe("2026-10-11T02:30");
	});
});

describe("parseDeliverAt", () => {
	it("interpreta horário sem fuso no fuso do usuário", () => {
		expect(parseDeliverAt("2026-10-11T07:00", NOW)?.toISOString()).toBe("2026-10-11T10:00:00.000Z");
	});
	it("vazio, inválido, passado e além do teto de 7 dias viram null", () => {
		expect(parseDeliverAt("", NOW)).toBeNull();
		expect(parseDeliverAt(undefined, NOW)).toBeNull();
		expect(parseDeliverAt("amanhã", NOW)).toBeNull();
		expect(parseDeliverAt("2026-10-01T07:00", NOW)).toBeNull();
		expect(parseDeliverAt("2026-10-30T07:00", NOW)).toBeNull();
	});
});

describe("planDeliveryDue", () => {
	const completedAt = new Date("2026-10-11T03:00:00.000Z");
	it("sem horário combinado, espera só a janela de coalescência", () => {
		expect(planDeliveryDue({ completedAt }).getTime()).toBe(completedAt.getTime() + DELIVERY_COALESCE_WINDOW_MS);
	});
	it("horário combinado no futuro vence a janela", () => {
		const deliverAfter = new Date("2026-10-11T10:00:00.000Z");
		expect(planDeliveryDue({ completedAt, deliverAfter }).toISOString()).toBe(deliverAfter.toISOString());
	});
	it("horário combinado que já passou não adianta nada além da janela", () => {
		const deliverAfter = new Date("2026-10-11T01:00:00.000Z");
		expect(planDeliveryDue({ completedAt, deliverAfter }).getTime()).toBe(completedAt.getTime() + DELIVERY_COALESCE_WINDOW_MS);
	});
});

describe("coalesceDeliveries", () => {
	const item = (id: string, userId: string): DueDelivery => ({
		id,
		userId,
		conversationId: `c-${id}`,
		botName: null,
		outcome: "completed",
		summary: "ok",
	});
	it("agrupa por usuário, uma notificação cada", () => {
		const batches = coalesceDeliveries([item("1", "a"), item("2", "b"), item("3", "a")]);
		expect(batches.map((b) => [b.userId, b.items.map((i) => i.id)])).toEqual([
			["a", ["1", "3"]],
			["b", ["2"]],
		]);
	});
});

describe("summarizeDeliveryText", () => {
	it("achata espaços e corta com reticências", () => {
		expect(summarizeDeliveryText("a \n b")).toBe("a b");
		const long = summarizeDeliveryText("x".repeat(500));
		expect(long.length).toBe(280);
		expect(long.endsWith("…")).toBe(true);
	});
});
