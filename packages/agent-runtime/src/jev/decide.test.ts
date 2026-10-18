import { afterEach, describe, expect, it, vi } from "vitest";
import { clipForJev, decideWithJev, jevModeFor, jevYes, parseJevFeatureMode, type JevAsk } from "./decide.js";

const questions = { q: { instructions: "?", criteria: { true: "t", false: "f" } } };
const ok: JevAsk = async () => ({ model: "m", answers: { q: 0.9 }, durationMs: 1 });

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("decideWithJev (F11)", () => {
	it("parseJevFeatureMode: padrão off", () => {
		expect(parseJevFeatureMode(undefined)).toBe("off");
		expect(parseJevFeatureMode("ON")).toBe("on");
		expect(parseJevFeatureMode("shadow")).toBe("shadow");
		expect(parseJevFeatureMode("gate")).toBe("off");
	});

	it("off ou sem cliente não chama", async () => {
		const ask = vi.fn(ok);
		expect(await decideWithJev({ rt: { ask, modes: {} }, feature: "intent", state: {}, questions })).toBeNull();
		expect(await decideWithJev({ rt: { modes: { intent: "on" } }, feature: "intent", state: {}, questions })).toBeNull();
		expect(ask).not.toHaveBeenCalled();
		expect(jevModeFor(undefined, "tools")).toBe("off");
	});

	it("sucesso devolve as probabilidades e registra sem conteúdo", async () => {
		const onDecision = vi.fn();
		const result = await decideWithJev({ rt: { ask: ok, modes: { verify: "on" }, onDecision }, feature: "verify", state: { secret: "x" }, questions });
		expect(result?.answers.q).toBe(0.9);
		expect(JSON.stringify(onDecision.mock.calls[0])).not.toContain("secret");
	});

	it("erro, malformado e probabilidade fora de 0–1 viram null", async () => {
		const modes = { stuck: "on" } as const;
		expect(await decideWithJev({ rt: { ask: async () => { throw new Error("x"); }, modes }, feature: "stuck", state: {}, questions })).toBeNull();
		expect(await decideWithJev({ rt: { ask: async () => ({ model: "m", answers: {}, durationMs: 1 }), modes }, feature: "stuck", state: {}, questions })).toBeNull();
		expect(await decideWithJev({ rt: { ask: async () => ({ model: "m", answers: { q: 2 }, durationMs: 1 }), modes }, feature: "stuck", state: {}, questions })).toBeNull();
	});

	it("timeout: um Jev que nunca responde não segura o run", async () => {
		vi.useFakeTimers();
		const hang: JevAsk = () => new Promise(() => undefined);
		const pending = decideWithJev({ rt: { ask: hang, modes: { stuck: "on" } }, feature: "stuck", state: {}, questions });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(await pending).toBeNull();
	});

	it("cancelamento do usuário propaga", async () => {
		const controller = new AbortController();
		const ask: JevAsk = async () => {
			controller.abort();
			throw new Error("aborted");
		};
		await expect(decideWithJev({ rt: { ask, modes: { intent: "on" } }, feature: "intent", state: {}, questions, signal: controller.signal })).rejects.toThrow();
	});

	it("log de depuração só com JEV_<X>_DEBUG=1, sem o conteúdo", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		await decideWithJev({ rt: { ask: ok, modes: { tools: "on" } }, feature: "tools", state: { text: "conteudo" }, questions });
		expect(info).not.toHaveBeenCalled();
		vi.stubEnv("JEV_TOOLS_DEBUG", "1");
		await decideWithJev({ rt: { ask: ok, modes: { tools: "on" } }, feature: "tools", state: { text: "conteudo" }, questions });
		expect(info).toHaveBeenCalledTimes(1);
		expect(String(info.mock.calls[0]![0])).not.toContain("conteudo");
		info.mockRestore();
	});

	it("clipForJev redige segredos e corta; jevYes respeita o limiar", () => {
		const clipped = clipForJev("Authorization: Bearer abcdefghijklmnop1234 " + "x".repeat(100), 60);
		expect(clipped).not.toContain("abcdefghijklmnop1234");
		expect(clipped.length).toBeLessThanOrEqual(60);
		expect(jevYes(0.79)).toBe(false);
		expect(jevYes(0.8)).toBe(true);
		expect(jevYes(undefined)).toBe(false);
	});
});
