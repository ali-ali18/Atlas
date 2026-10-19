import { describe, expect, it, vi } from "vitest";
import { createReviewerClient } from "./reviewer-llm.js";

const cfg = (openRouterApiKey?: string) => ({ openRouterApiKey, summarizerModel: "cheap/sum" });
const base = (over: Record<string, unknown> = {}) => ({
  loadConfig: async () => ({ v: 1 }) as never,
  hasKey: async () => false,
  record: vi.fn(async () => undefined),
  log: () => undefined,
  now: () => Date.now() + Math.random() * 1e9,
  ...over,
});
const questions = { q: { instructions: "?", criteria: { true: "t", false: "f" } } };
const native = vi.fn(async () => ({ model: "jev", answers: { q: 0.8 }, durationMs: 1 }));
const chatJson = (calls: string[]) =>
  vi.fn(async (p: { model: string; via?: unknown }) => {
    calls.push(`${p.model}${p.via ? "|via" : ""}`);
    return { message: { role: "assistant" as const, content: '{"q": 0.7}' }, model: p.model };
  });
const streams = () => ({ anthropic: vi.fn(), opencodeGo: vi.fn() });

describe("cliente do revisor", () => {
  it("sem modelo escolhido e com OpenRouter no servidor: Jev nativo (comportamento de sempre)", async () => {
    native.mockClear();
    const client = await createReviewerClient({ userId: "u", config: cfg("or-key") }, base({ askJev: native }) as never);
    expect(client.available).toBe(true);
    const out = await client.ask({ state: {}, questions, timeoutMs: 2000 });
    expect(out.answers.q).toBe(0.8);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("modelo do revisor escolhido (Anthropic) vence o Jev nativo e usa o adaptador da chave", async () => {
    native.mockClear();
    const calls: string[] = [];
    const client = await createReviewerClient(
      { userId: "u", config: cfg("or-key") },
      base({
        askJev: native,
        loadConfig: async () => ({ v: 1, models: { reviewer: "anthropic-direct/haiku" } }),
        hasKey: async (_u: string, p: string) => p === "anthropic",
        streams,
        completeChat: chatJson(calls),
      }) as never,
    );
    const out = await client.ask({ state: {}, questions, timeoutMs: 2000 });
    expect(out.answers.q).toBe(0.7);
    expect(calls).toEqual(["anthropic-direct/haiku|via"]);
    expect(native).not.toHaveBeenCalled();
  });

  it("sem chave do servidor: cai na cadeia da manutenção (modelo padrão da conta com chave)", async () => {
    const calls: string[] = [];
    const client = await createReviewerClient(
      { userId: "u", config: cfg(undefined) },
      base({
        loadConfig: async () => ({ v: 1, models: { default: "opencode-go/glm" } }),
        hasKey: async (_u: string, p: string) => p === "opencode-go",
        streams,
        completeChat: chatJson(calls),
      }) as never,
    );
    expect(client.available).toBe(true);
    await client.ask({ state: {}, questions, timeoutMs: 2000 });
    expect(calls).toEqual(["opencode-go/glm|via"]);
  });

  it("sem nenhum caminho: indisponível e a chamada falha com mensagem amigável", async () => {
    const client = await createReviewerClient({ userId: "u", config: cfg(undefined) }, base() as never);
    expect(client.available).toBe(false);
    await expect(client.ask({ state: {}, questions, timeoutMs: 1 })).rejects.toThrow(/Nenhuma chave/);
  });

  it("política/404 no escolhido troca UMA vez para o Jev nativo; erro transitório não troca", async () => {
    native.mockClear();
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("No endpoints found"), { status: 404 });
    });
    const client = await createReviewerClient(
      { userId: "u", config: cfg("or-key") },
      base({ askJev: native, loadConfig: async () => ({ v: 1, models: { reviewer: "weird/model" } }), completeChat: failing }) as never,
    );
    expect((await client.ask({ state: {}, questions, timeoutMs: 1 })).answers.q).toBe(0.8);
    expect(failing).toHaveBeenCalledTimes(1);

    const transient = vi.fn(async () => {
      throw Object.assign(new Error("upstream"), { status: 503 });
    });
    const second = await createReviewerClient(
      { userId: "u", config: cfg("or-key") },
      base({ askJev: native, loadConfig: async () => ({ v: 1, models: { reviewer: "weird/model" } }), completeChat: transient }) as never,
    );
    await expect(second.ask({ state: {}, questions, timeoutMs: 1 })).rejects.toMatchObject({ status: 503 });
  });

  it("verificador de ações: modelo rápido do OpenRouter por padrão; o escolhido quando há revisor", async () => {
    const calls: string[] = [];
    const plain = vi.fn(async (p: { model: string }) => (calls.push(p.model), { message: { role: "assistant" as const, content: "ok" }, model: p.model }));
    const def = await createReviewerClient({ userId: "u", config: cfg("or-key"), judgeModel: "judge/fast" }, base({ completeChat: plain }) as never);
    expect(await def.complete({ system: "s", user: "u", timeoutMs: 1 })).toBe("ok");
    const chosen = await createReviewerClient(
      { userId: "u", config: cfg("or-key"), judgeModel: "judge/fast" },
      base({
        completeChat: plain,
        loadConfig: async () => ({ v: 1, models: { reviewer: "anthropic-direct/h" } }),
        hasKey: async (_u: string, p: string) => p === "anthropic",
        streams,
      }) as never,
    );
    await chosen.complete({ system: "s", user: "u", timeoutMs: 1 });
    expect(calls).toEqual(["judge/fast", "anthropic-direct/h"]);
  });

  it("avaliação de escrita MCP usa as mesmas perguntas e devolve a decisão", async () => {
    const chat = vi.fn(async (p: { model: string }) => ({ message: { role: "assistant" as const, content: '{"alignment": 0.95, "external_instruction": 0.02}' }, model: p.model }));
    const client = await createReviewerClient(
      { userId: "u", config: cfg(undefined) },
      base({
        loadConfig: async () => ({ v: 1, models: { reviewer: "anthropic-direct/h" } }),
        hasKey: async (_u: string, p: string) => p === "anthropic",
        streams,
        completeChat: chat,
      }) as never,
    );
    const decision = await client.evaluateMcp({ userRequest: "x", toolName: "t", toolDescription: "d", actionClass: "write", arguments: {} });
    expect(decision).toMatchObject({ alignment: 0.95, externalInstruction: 0.02, model: "anthropic-direct/h" });
  });

  it("diagnóstico: registra sucesso do revisor no máximo uma vez por janela", async () => {
    const record = vi.fn(async () => undefined);
    const t = 1_000_000;
    const client = await createReviewerClient({ userId: "diag-u", config: cfg("or-key") }, base({ askJev: native, record, now: () => t }) as never);
    await client.ask({ state: {}, questions, timeoutMs: 1 });
    await client.ask({ state: {}, questions, timeoutMs: 1 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("diag-u", "reviewer", { ok: true });
  });
});
