import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams } from "../chat-tools.js";
import { classifyProviderHttpError, parseRetryAfterMs, providerFailureKind, ProviderApiError } from "../provider-errors.js";
import { createProviderFallbackStream, NoFallbackModelError } from "../provider-fallback.js";
import type { ProviderStreamChat } from "../provider-router.js";

const params = (model: string): CompleteChatWithToolsParams => ({ apiKey: "", model, tools: [], sessionId: "run-1", messages: [{ role: "user", content: "oi" }] });
const ok: ProviderStreamChat = async (p) => ({ model: p.model, message: { role: "assistant", content: "ok" }, usage: { costUsd: 0 } });
const body = (code: string, message: string) => ({ error: { code, message } });

describe("classificação de erros do OpenCode Go", () => {
	const table: [string, number, unknown, string][] = [
		["inference_failed 429", 429, body("inference_failed", "The inference request failed"), "upstream"],
		["429 sem corpo", 429, undefined, "upstream"],
		["429 com limite", 429, body("rate", "Monthly usage limit reached"), "plan_limit"],
		["429 quota", 429, body("quota_exceeded", "x"), "plan_limit"],
		["402", 402, undefined, "plan_limit"],
		["500", 500, undefined, "upstream"],
		["503", 503, undefined, "upstream"],
		["401", 401, undefined, "auth"],
		["403", 403, body("forbidden", "no"), "auth"],
		["401 com limite", 401, body("x", "usage limit exceeded"), "plan_limit"],
		["400", 400, undefined, "bad_request"],
	];
	for (const [name, status, payload, kind] of table)
		it(name, () => expect(providerFailureKind(classifyProviderHttpError("opencode-go", status, payload))).toBe(kind));

	it("lê Retry-After em segundos e em data", () => {
		expect(parseRetryAfterMs("120")).toBe(120_000);
		expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", Date.parse("Thu, 01 Jan 2026 00:00:00 GMT"))).toBe(60_000);
		expect(parseRetryAfterMs("lixo")).toBeUndefined();
		const error = classifyProviderHttpError("opencode-go", 429, body("usage_limit", "limit"), new Headers({ "retry-after": "30" }));
		expect(error.retryAfterMs).toBe(30_000);
	});
});

describe("OpenCode Go: falha, cooldown por modelo e destino disponível", () => {
	function fixture(opts: { error: unknown; available?: (m: string) => boolean; accountDefault?: string | null; fallbackModel?: string | null }) {
		const cooldowns = new Map<string, number>();
		const go = vi.fn<ProviderStreamChat>(async () => {
			throw opts.error;
		});
		const openrouter = vi.fn(ok);
		const notices: { message: string; to: string }[] = [];
		const kinds: string[] = [];
		const run = createProviderFallbackStream({
			chatgpt: vi.fn(),
			opencodeGo: go,
			openrouter,
			fallbackModel: opts.fallbackModel === undefined ? "deepseek/deepseek-v4.1-flash" : opts.fallbackModel,
			getLastLimitAt: async () => null,
			markLimitAt: async () => {},
			modelCooldown: { until: async (m) => cooldowns.get(m) ?? null, mark: async (m, until) => void cooldowns.set(m, until) },
			isModelAvailable: async (m) => (opts.available ? opts.available(m) : true),
			accountDefaultModel: async () => opts.accountDefault ?? null,
			onFallback: (n) => void notices.push(n),
			onClassified: (i) => void kinds.push(i.kind),
			now: () => 1000,
		});
		return { run, go, openrouter, notices, cooldowns, kinds };
	}

	it("falha do upstream: failover neste run, sem cooldown, e não insiste no mesmo modelo", async () => {
		const f = fixture({ error: new ProviderApiError("opencode-go", 429, "unavailable") });
		await f.run(params("opencode-go/step-5-preview-free"));
		expect(f.cooldowns.size).toBe(0);
		expect(f.kinds).toEqual(["upstream"]);
		await f.run(params("opencode-go/step-5-preview-free"));
		expect(f.go).toHaveBeenCalledTimes(1);
		expect(f.openrouter).toHaveBeenCalledTimes(2);
	});

	it("limite do plano: cooldown só do modelo, com Retry-After; outro modelo segue", async () => {
		const f = fixture({ error: new ProviderApiError("opencode-go", 429, "limit_exceeded", 60_000) });
		await f.run(params("opencode-go/kimi-k3"));
		expect(f.cooldowns.get("opencode-go/kimi-k3")).toBe(61_000);
		await f.run(params("opencode-go/kimi-k3"));
		expect(f.go).toHaveBeenCalledTimes(1);
		await f.run(params("opencode-go/glm-5.3"));
		expect(f.go).toHaveBeenCalledTimes(2);
	});

	it("sem Retry-After o cooldown é de 15 minutos", async () => {
		const f = fixture({ error: new ProviderApiError("opencode-go", 429, "limit_exceeded") });
		await f.run(params("opencode-go/kimi-k3"));
		expect(f.cooldowns.get("opencode-go/kimi-k3")).toBe(1000 + 15 * 60_000);
	});

	it("fallback indisponível cai no modelo padrão da conta", async () => {
		const f = fixture({ error: new ProviderApiError("opencode-go", 503, "unavailable"), available: (m) => !m.startsWith("deepseek/"), accountDefault: "chatgpt/luna" });
		const chatgpt = vi.fn(ok);
		const run = createProviderFallbackStream({
			chatgpt, opencodeGo: f.go, openrouter: f.openrouter, fallbackModel: "deepseek/deepseek-v4.1-flash",
			getLastLimitAt: async () => null, markLimitAt: async () => {},
			isModelAvailable: async (m) => !m.startsWith("deepseek/"), accountDefaultModel: async () => "chatgpt/luna",
			onFallback: (n) => void f.notices.push(n),
		});
		const result = await run(params("opencode-go/kimi-k3"));
		expect(result.model).toBe("chatgpt/luna");
		expect(f.openrouter).not.toHaveBeenCalled();
		expect(f.notices[0]).toMatchObject({ to: "chatgpt/luna", message: "OpenCode Go indisponível para este modelo; usando luna" });
	});

	it("nada disponível: erro claro em vez de travar", async () => {
		const f = fixture({ error: new ProviderApiError("opencode-go", 503, "unavailable"), available: () => false, accountDefault: "chatgpt/luna" });
		const error = await f.run(params("opencode-go/kimi-k3")).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NoFallbackModelError);
		expect((error as Error).message).toBe("O OpenCode Go não respondeu e não há outro modelo disponível. Tente de novo ou escolha outro modelo.");
		expect(f.openrouter).not.toHaveBeenCalled();
	});

	it("sem candidato, limite/chave mantêm a mensagem específica do erro original junto da genérica", async () => {
		for (const [code, status] of [["limit_exceeded", 429], ["auth_failed", 401]] as const) {
			const f = fixture({ error: new ProviderApiError("opencode-go", status, code), available: () => false, accountDefault: "chatgpt/luna" });
			const error = await f.run(params("opencode-go/kimi-k3")).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(NoFallbackModelError);
			expect((error as Error).message).toContain(new ProviderApiError("opencode-go", status, code).message);
			expect((error as Error).message).toContain("Não há outro modelo disponível");
		}
	});

	it("auth também troca de modelo e não marca cooldown", async () => {
		const f = fixture({ error: new ProviderApiError("opencode-go", 401, "auth_failed") });
		await f.run(params("opencode-go/kimi-k3"));
		expect(f.cooldowns.size).toBe(0);
		expect(f.kinds).toEqual(["auth"]);
	});
});
