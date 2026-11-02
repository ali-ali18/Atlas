import { describe, expect, it } from "vitest";
import { canRenewAfterDrop, DROP_RENEW_GAP_MS, isLinkExpired, LINK_RENEW_MS, LINK_TTL_MS, renewDelayMs, shouldRenew } from "./computer-link";
import { checkVmText, VM_TEXT_MAX, vmTextProblem } from "./computer-text";

describe("renovação do link da tela", () => {
	it("renova antes de o token (10 min) vencer", () => {
		expect(LINK_RENEW_MS).toBeLessThan(LINK_TTL_MS);
	});
	it("conta o tempo que falta até os 8 minutos", () => {
		expect(renewDelayMs(1_000, 1_000)).toBe(LINK_RENEW_MS);
		expect(renewDelayMs(1_000, 1_000 + 60_000)).toBe(LINK_RENEW_MS - 60_000);
	});
	it("passou da hora: 0 e shouldRenew", () => {
		const at = 5_000;
		expect(shouldRenew(at, at + LINK_RENEW_MS - 1)).toBe(false);
		expect(shouldRenew(at, at + LINK_RENEW_MS)).toBe(true);
		expect(renewDelayMs(at, at + LINK_TTL_MS * 2)).toBe(0);
	});
	it("vencido é a partir dos 10 minutos", () => {
		expect(isLinkExpired(0, LINK_TTL_MS - 1)).toBe(false);
		expect(isLinkExpired(0, LINK_TTL_MS)).toBe(true);
	});
	it("queda de conexão renova, mas não em laço", () => {
		expect(canRenewAfterDrop(10_000, 10_000 + DROP_RENEW_GAP_MS - 1)).toBe(false);
		expect(canRenewAfterDrop(10_000, 10_000 + DROP_RENEW_GAP_MS)).toBe(true);
	});
});

describe("texto para a VM", () => {
	it("aceita texto comum e preserva quebras e espaços", () => {
		expect(checkVmText(" olá\n")).toEqual({ ok: true, text: " olá\n" });
	});
	it("recusa vazio e só espaços", () => {
		expect(checkVmText("")).toEqual({ ok: false, reason: "empty" });
		expect(checkVmText(" \n\t")).toEqual({ ok: false, reason: "empty" });
	});
	it("o limite é 5000: exatamente 5000 passa, 5001 não", () => {
		expect(VM_TEXT_MAX).toBe(5000);
		expect(checkVmText("a".repeat(5000)).ok).toBe(true);
		expect(checkVmText("a".repeat(5001))).toEqual({ ok: false, reason: "too-long" });
		expect(vmTextProblem("too-long")).toContain("5000");
	});
});
