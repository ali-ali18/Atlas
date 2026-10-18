import { describe, expect, it } from "vitest";
import {
	compactErrorDetail,
	createSandboxErrorTracker,
	friendlySandboxError,
	isSandboxInfraError,
} from "./sandbox-errors.js";

describe("friendlySandboxError", () => {
	const messages = [
		"fetch failed",
		"Chrome indisponível após tentativa de recuperação na VM",
		"Session not found: abc",
		"Timeout 15000ms exceeded",
		"Sandbox disabled (set SANDBOX_ENABLED=true)",
	];

	it("nunca manda repetir a ação e aponta para snapshot/screenshot, não browser_text", () => {
		for (const message of messages) {
			const out = friendlySandboxError("browser_click", message);
			expect(out, message).not.toMatch(/repit|de novo uma vez|tente de novo/i);
			expect(out, message).not.toContain("browser_text");
			expect(out, message).toContain(message);
		}
		expect(friendlySandboxError("type", "fetch failed")).toMatch(/browser_snapshot/);
	});

	it("classifica infraestrutura x erro da página", () => {
		expect(isSandboxInfraError("fetch failed")).toBe(true);
		expect(isSandboxInfraError("Chrome indisponível")).toBe(true);
		expect(isSandboxInfraError("Timeout 15000ms exceeded")).toBe(false);
	});
});

describe("createSandboxErrorTracker (F12/A5)", () => {
	it("na 2ª falha seguida de infra manda sair do computador", () => {
		const tracker = createSandboxErrorTracker();
		expect(tracker.onFailure("navigate", "fetch failed")).not.toContain("PARE de usar");
		const second = tracker.onFailure("navigate", "Chrome indisponível após tentativa");
		expect(second).toContain("PARE de usar");
		expect(second).toContain("web_extract");
	});

	it("sucesso ou erro da página zera a sequência", () => {
		const tracker = createSandboxErrorTracker();
		tracker.onFailure("navigate", "fetch failed");
		tracker.onSuccess();
		expect(tracker.onFailure("navigate", "fetch failed")).not.toContain("PARE de usar");
		tracker.onFailure("browser_click", "Timeout 15000ms exceeded");
		expect(tracker.streak).toBe(0);
	});
});


describe("compactErrorDetail (V1)", () => {
	const step = "  - waiting for element to be visible, enabled and stable";

	it("corta o call log do Playwright e limita a 300 caracteres", () => {
		const raw = ["locator.click: Timeout 15000ms exceeded.", "Call log:", ...Array(80).fill(step)].join("\n");
		expect(raw.length).toBeGreaterThan(4000);
		expect(compactErrorDetail(raw)).toBe("locator.click: Timeout 15000ms exceeded.");
		expect(compactErrorDetail("x".repeat(2000)).length).toBeLessThanOrEqual(300);
	});

	it("o erro que chega ao modelo não despeja o log inteiro", () => {
		const raw = ["Timeout 15000ms exceeded.", "Call log:", ...Array(200).fill("  - retrying click action")].join("\n");
		const out = friendlySandboxError("browser_click", raw);
		expect(out).not.toContain("retrying click action");
		expect(out.length).toBeLessThan(900);
	});
});
