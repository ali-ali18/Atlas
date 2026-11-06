import { EXAMPLE_ROLE_CHAINS } from "@workspace/shared";
import type { ProviderStreamChat } from "@workspace/llm";
import { describe, expect, it } from "vitest";
import type { LlmChatRequest, LlmStreamEvent } from "../../ports/llm.js";
import { LlmUnavailableError, createLlmAdapter } from "./adapter.js";
import { mergeConsecutiveUser, mergeLeadingSystem } from "./map.js";

type Params = Parameters<ProviderStreamChat>[0];
type Handlers = NonNullable<Parameters<ProviderStreamChat>[1]>;
type Script = (params: Params, handlers: Handlers) => Promise<Awaited<ReturnType<ProviderStreamChat>>>;

const T0 = Date.parse("2026-11-05T12:00:00Z");
let nowMs = T0;
const clock = { now: () => new Date(nowMs) };

function ok(text: string, extra: Record<string, unknown> = {}): Script {
	return async (params, handlers) => {
		if (text) handlers.onDelta?.(text);
		return {
			message: { role: "assistant", content: text || null },
			model: params.model,
			usage: { promptTokens: 10, completionTokens: 3, cachedTokens: 4, costUsd: 0.01 },
			finishReason: "stop",
			...extra,
		} as Awaited<ReturnType<ProviderStreamChat>>;
	};
}
const fail = (status: number, extra: Record<string, unknown> = {}): Script => async () => {
	throw Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
};

function setup(scripts: Script[], opts: Partial<Parameters<typeof createLlmAdapter>[0]> = {}) {
	nowMs = T0;
	const calls: Params[] = [];
	let i = 0;
	const streamChat = ((params: Params, handlers: Handlers = {}) => {
		calls.push(params);
		const script = scripts[Math.min(i++, scripts.length - 1)] as Script;
		return script(params, handlers);
	}) as ProviderStreamChat;
	const llm = createLlmAdapter({ streamChat, chains: EXAMPLE_ROLE_CHAINS, apiKeyFor: () => "k", clock, ...opts });
	return { llm, calls };
}
async function collect(it: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
	const out: LlmStreamEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}
const req = (over: Partial<LlmChatRequest> = {}): LlmChatRequest => ({ role: "main", messages: [{ role: "user", content: "oi" }], ...over });

describe("adaptador Llm", () => {
	it("usa a primeira entrada saudável e reporta usage e served", async () => {
		const { llm, calls } = setup([ok("olá")]);
		const events = await collect(llm.chat(req()));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe("anthropic-direct/claude-sonnet-5-5");
		expect(events).toEqual([
			{ type: "text_delta", text: "olá" },
			{
				type: "done",
				finishReason: "stop",
				usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4, costUsd: 0.01 },
				served: { provider: "anthropic", model: "anthropic-direct/claude-sonnet-5-5" },
			},
		]);
	});

	it("429 antes de qualquer saída troca para a próxima entrada na mesma chamada, com aviso", async () => {
		const { llm, calls } = setup([fail(429), ok("certo")]);
		const events = await collect(llm.chat(req()));
		expect(calls.map((c) => c.model)).toEqual(["anthropic-direct/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"]);
		const notice = events.find((e) => e.type === "notice");
		expect(notice).toMatchObject({ message: expect.stringContaining("anthropic/claude-sonnet-5-5") });
		expect(notice && "message" in notice && notice.message).toContain("openrouter/anthropic/claude-sonnet-5-5");
		expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop", served: { provider: "openrouter" } });
	});

	it("cota e 5xx e erro de rede também trocam", async () => {
		for (const script of [fail(402), fail(503), (async () => { throw new TypeError("fetch failed"); }) as Script, fail(500, { code: "unavailable" })]) {
			const { llm, calls } = setup([script, ok("x")]);
			const events = await collect(llm.chat(req()));
			expect(calls).toHaveLength(2);
			expect(events.some((e) => e.type === "notice")).toBe(true);
		}
	});

	it("falha no meio do stream: devolve error com o parcial, sem emendar outro modelo", async () => {
		const midway: Script = async (_p, h) => {
			h.onDelta?.("começo da resp");
			throw Object.assign(new Error("cortou"), { code: "stream_interrupted" });
		};
		const { llm, calls } = setup([midway, ok("nunca")]);
		const events = await collect(llm.chat(req()));
		expect(calls).toHaveLength(1);
		expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
		expect(events[1]).toMatchObject({ finishReason: "error", served: { provider: "anthropic" } });
	});

	it("a próxima chamada respeita o cooldown e pula o provedor caído", async () => {
		const { llm, calls } = setup([fail(429), ok("a"), ok("b")]);
		await collect(llm.chat(req()));
		await collect(llm.chat(req()));
		expect(calls.map((c) => c.model)).toEqual(["anthropic-direct/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"]);
		nowMs = T0 + 61_000;
		await collect(llm.chat(req()));
		expect(calls[3]?.model).toBe("anthropic-direct/claude-sonnet-5-5");
	});

	it("Retry-After do provedor define o cooldown", async () => {
		const { llm, calls } = setup([fail(429, { retryAfterMs: 5 * 60_000 }), ok("a"), ok("b")]);
		await collect(llm.chat(req()));
		nowMs = T0 + 120_000;
		await collect(llm.chat(req()));
		expect(calls[2]?.model).toBe("anthropic/claude-sonnet-5-5");
	});

	it("tudo caindo na mesma chamada lança indisponível com o motivo real", async () => {
		const { llm } = setup([fail(503)]);
		const err = await collect(llm.chat(req())).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmUnavailableError);
		const reason = (err as LlmUnavailableError).reason;
		expect(reason.kind).toBe("all_unavailable");
		expect((err as Error).message).toContain("indisponíveis");
		expect((err as Error).message).not.toMatch(/cadeia/);
	});

	it("teto do dono atingido: erro honesto com valor e origem, sem chamar o provedor", async () => {
		const { llm, calls } = setup([ok("x")], { ceilings: { account: { month: 20 } }, spend: { account: { month: 21.5 } } });
		const err = (await collect(llm.chat(req())).catch((e: unknown) => e)) as LlmUnavailableError;
		expect(calls).toHaveLength(0);
		expect(err.reason).toEqual({ kind: "ceiling", period: "month", source: "account", limitUsd: 20, spentUsd: 21.5 });
		expect(err.message).toContain("da conta");
		expect(err.message).toContain("20.00");
	});

	it("textos ao dono seguem o idioma do bot, sem vocabulário interno nem US$ fixo (auditoria F1, A1)", async () => {
		const ceiling = { ceilings: { account: { month: 20 } }, spend: { account: { month: 21.5 } } };
		for (const [language, re] of [["pt-BR", /Teto mensal da conta atingido: 21\.50 de 20\.00 \(em dólares, USD\)/], ["en-US", /Monthly spending limit for your account reached: 21\.50 of 20\.00/], ["es-ES", /Tope mensual de la cuenta alcanzado/]] as const) {
			const { llm } = setup([ok("x")], { ...ceiling, language });
			const err = (await collect(llm.chat(req())).catch((e: unknown) => e)) as LlmUnavailableError;
			expect(err.message).toMatch(re);
			expect(err.message).not.toMatch(/US\$|cadeia|papel/);
		}
		const { llm } = setup([fail(429), ok("certo")], { language: "en-US" });
		const notice = (await collect(llm.chat(req()))).find((e) => e.type === "notice") as { message: string };
		expect(notice.message).toMatch(/^I switched from .* to .* because the provider is limiting requests\.$/);
		const down = setup([fail(503)], { language: "es-ES" });
		const err = (await collect(down.llm.chat(req())).catch((e: unknown) => e)) as Error;
		expect(err.message).toMatch(/^Los modelos configurados no están disponibles ahora: /);
	});

	it("erro do pedido (400) não troca de provedor", async () => {
		const { llm, calls } = setup([fail(400), ok("x")]);
		await expect(collect(llm.chat(req()))).rejects.toThrow("HTTP 400");
		expect(calls).toHaveLength(1);
	});

	it("cancelamento do dono não vira troca de provedor", async () => {
		const ctrl = new AbortController();
		const aborting: Script = async () => {
			ctrl.abort();
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		};
		const { llm, calls } = setup([aborting, ok("x")]);
		await expect(collect(llm.chat(req({ signal: ctrl.signal })))).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	it("entrada sem chave é pulada com aviso", async () => {
		const { llm, calls } = setup([ok("x")], { apiKeyFor: (p) => (p === "anthropic" ? undefined : "k") });
		const events = await collect(llm.chat(req()));
		expect(calls[0]?.model).toBe("anthropic/claude-sonnet-5-5");
		expect(events.some((e) => e.type === "notice")).toBe(true);
	});

	it("modelo sem visão: troca de entrada sem pôr o provedor em quarentena", async () => {
		const { llm, calls } = setup([fail(400, { reason: "no_image_support" }), ok("vi"), ok("de novo")]);
		await collect(llm.chat(req({ role: "vision" })));
		await collect(llm.chat(req({ role: "vision" })));
		expect(calls[2]?.model).toBe("anthropic-direct/claude-sonnet-5-5");
	});

	it("funde os system do começo, em ordem, e mantém os demais", async () => {
		const { llm, calls } = setup([ok("x")]);
		await collect(
			llm.chat(
				req({
					messages: [
						{ role: "system", content: "A" },
						{ role: "system", content: "[context]" },
						{ role: "user", content: "oi" },
						{ role: "system", content: "nota" },
					],
				}),
			),
		);
		expect(calls[0]?.messages).toEqual([
			{ role: "system", content: "A\n\n[context]" },
			{ role: "user", content: "oi" },
			{ role: "system", content: "nota" },
		]);
		expect(mergeLeadingSystem([{ role: "system", content: "só um" }])).toHaveLength(1);
	});

	it("não funde quando o provedor aceita vários system", async () => {
		const { llm, calls } = setup([ok("x")], { singleSystemProviders: ["opencode-go"] });
		await collect(llm.chat(req({ messages: [{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "oi" }] })));
		expect(calls[0]?.messages).toHaveLength(3);
	});

	it("funde user seguidos na requisição (e só eles)", async () => {
		const { llm, calls } = setup([ok("x")]);
		await collect(
			llm.chat(
				req({
					messages: [
						{ role: "system", content: "S" },
						{ role: "user", content: "a" },
						{ role: "user", content: "b" },
						{ role: "assistant", content: "r", toolCalls: [{ id: "1", name: "t", args: {} }] },
						{ role: "tool", toolCallId: "1", content: "d" },
						{ role: "user", content: "c" },
					],
				}),
			),
		);
		expect(calls[0]?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
		expect(calls[0]?.messages[1]).toEqual({ role: "user", content: "a\n\nb" });
	});

	it("mergeUserProviders sem o provedor atual não funde", async () => {
		const { llm, calls } = setup([ok("x")], { mergeUserProviders: ["openrouter"] });
		await collect(llm.chat(req({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] })));
		expect(calls[0]?.messages).toHaveLength(2);
	});

	it("mergeConsecutiveUser: com imagem vira lista de partes na ordem e não altera a entrada", () => {
		const input = [
			{ role: "user" as const, content: "veja" },
			{ role: "user" as const, content: [{ type: "image" as const, mediaType: "image/png", data: "AA" }] },
			{ role: "user" as const, content: "e isto" },
		];
		const snapshot = structuredClone(input);
		const out = mergeConsecutiveUser(input);
		expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "veja" }, { type: "image", mediaType: "image/png", data: "AA" }, { type: "text", text: "e isto" }] }]);
		expect(input).toEqual(snapshot);
		expect(mergeConsecutiveUser([])).toEqual([]);
	});

	it("mapeia imagem (base64 e url) para o papel vision", async () => {
		const { llm, calls } = setup([ok("vejo")]);
		await collect(
			llm.chat(
				req({
					role: "vision",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "o que é?" },
								{ type: "image", mediaType: "image/png", data: "AAAA" },
								{ type: "image", mediaType: "image/jpeg", url: "https://x.test/a.jpg" },
							],
						},
					],
				}),
			),
		);
		expect(calls[0]?.messages[0]?.content).toEqual([
			{ type: "text", text: "o que é?" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			{ type: "image_url", image_url: { url: "https://x.test/a.jpg" } },
		]);
	});

	it("mapeia tools, tool_calls do histórico e a resposta com tool_call", async () => {
		const toolRes: Script = async (p) =>
			({
				message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ler", arguments: '{"a":1}' } }] },
				model: p.model,
				usage: { promptTokens: 1, completionTokens: 1 },
				finishReason: "tool_calls",
			}) as Awaited<ReturnType<ProviderStreamChat>>;
		const { llm, calls } = setup([toolRes]);
		const events = await collect(
			llm.chat(
				req({
					tools: [{ name: "ler", description: "lê", inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } }],
					messages: [
						{ role: "user", content: "oi" },
						{ role: "assistant", content: "", toolCalls: [{ id: "c0", name: "ler", args: { a: 0 } }] },
						{ role: "tool", toolCallId: "c0", content: "ok" },
					],
				}),
			),
		);
		expect(calls[0]?.tools).toEqual([{ type: "function", function: { name: "ler", description: "lê", parameters: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } } }]);
		expect(calls[0]?.messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "ler", arguments: '{"a":0}' } }] });
		expect(calls[0]?.messages[2]).toEqual({ role: "tool", content: "ok", tool_call_id: "c0" });
		expect(events[0]).toEqual({ type: "tool_call", call: { id: "c1", name: "ler", args: { a: 1 } } });
		expect(events.at(-1)).toMatchObject({ finishReason: "tool_calls" });
	});

	it("toolChoice 'none' (passo final de um limite) chega ao provedor; omitido, não manda nada (auditoria F1, B3/C4)", async () => {
		const tools = [{ name: "ler", description: "lê", inputSchema: { type: "object", properties: {} } }];
		const a = setup([ok("x")]);
		await collect(a.llm.chat(req({ tools, toolChoice: "none" })));
		expect(a.calls[0]?.toolChoice).toBe("none");
		expect(a.calls[0]?.tools).toHaveLength(1);
		const b = setup([ok("x")]);
		await collect(b.llm.chat(req({ tools })));
		expect(b.calls[0]).not.toHaveProperty("toolChoice");
	});

	it("throw síncrono do streamChat passa pela classificação e troca de entrada (auditoria F1, B17)", async () => {
		let n = 0;
		const streamChat = ((params: Params, handlers: Handlers = {}) => {
			calls.push(params);
			if (n++ === 0) throw Object.assign(new Error("HTTP 503"), { status: 503 });
			return ok("certo")(params, handlers);
		}) as ProviderStreamChat;
		const calls: Params[] = [];
		const llm = createLlmAdapter({ streamChat, chains: EXAMPLE_ROLE_CHAINS, apiKeyFor: () => "k", clock });
		const events = await collect(llm.chat(req()));
		expect(calls).toHaveLength(2);
		expect(events.map((e) => e.type)).toEqual(["notice", "text_delta", "done"]);
	});

	it("o schema da tool vai inteiro (anyOf/oneOf não somem) e schema que não é objeto falha alto (auditoria F1, B17)", async () => {
		const schema = { type: "object", properties: { a: { type: "string" } }, anyOf: [{ required: ["a"] }, { required: ["b"] }], additionalProperties: false };
		const { llm, calls } = setup([ok("x")]);
		await collect(llm.chat(req({ tools: [{ name: "t", description: "d", inputSchema: schema }] })));
		expect(calls[0]?.tools?.[0]?.function.parameters).toMatchObject({ anyOf: schema.anyOf, additionalProperties: false });
		const bad = setup([ok("x")]);
		await expect(collect(bad.llm.chat(req({ tools: [{ name: "t", description: "d", inputSchema: { type: "array" } }] })))).rejects.toThrow(/tipo object/);
	});

	it("timeouts de transporte são generosos e configuráveis, sem corte de 30s/20s/90s", async () => {
		const a = setup([ok("x")]);
		await collect(a.llm.chat(req()));
		expect(a.calls[0]).toMatchObject({ firstEventTimeoutMs: 120_000, idleTimeoutMs: 120_000, timeoutMs: 3_600_000, progressTimeoutMs: 3_600_000 });
		const b = setup([ok("x")], { timeouts: { idleMs: 300_000 } });
		await collect(b.llm.chat(req()));
		expect(b.calls[0]).toMatchObject({ idleTimeoutMs: 300_000, firstEventTimeoutMs: 120_000 });
	});

	it("cadeia de uma entrada: erro transitório não põe o único provedor em quarentena e o retry tenta de novo (auditoria F1, C3)", async () => {
		const chains = { ...EXAMPLE_ROLE_CHAINS, main: [EXAMPLE_ROLE_CHAINS.main[0]!] };
		const { llm, calls } = setup([fail(503), ok("voltou")], { chains });
		const first = await collect(llm.chat(req())).catch((e: unknown) => e);
		expect(first).toBeInstanceOf(LlmUnavailableError);
		const second = await collect(llm.chat(req()));
		expect(calls).toHaveLength(2);
		expect(second.map((e) => e.type)).toEqual(["text_delta", "done"]);
	});

	it("contextWindow lembra a última janela conhecida em vez de cair para 128k (auditoria F1, C3)", async () => {
		let fails = false;
		const { llm } = setup([fail(429), ok("x")], {
			chains: { ...EXAMPLE_ROLE_CHAINS, main: [EXAMPLE_ROLE_CHAINS.main[0]!, EXAMPLE_ROLE_CHAINS.main[1]!] },
			contextWindowFor: async () => {
				if (fails) throw new Error("capacidades fora do ar");
				return 200_000;
			},
		});
		expect(await llm.contextWindow("main")).toBe(200_000);
		fails = true;
		expect(await llm.contextWindow("main")).toBe(200_000);
		expect(await llm.contextWindow("helper")).toBe(128_000);
	});

	it("contextWindow usa a entrada atual do papel", async () => {
		const { llm } = setup([ok("x")], { contextWindowFor: (e) => (e.provider === "anthropic" ? 200_000 : 1) });
		expect(await llm.contextWindow("main")).toBe(200_000);
	});
});
