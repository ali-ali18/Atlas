import { expect, it } from "vitest";
import { isRetryableLlmError, withLlmStepRetry } from "./config.js";
import { OpenRouterError } from "./sse-stream.js";

it("erros permanentes não retentam mesmo contendo números de endpoint", () => {
    for (const status of [400, 401, 403]) expect(isRetryableLlmError(new OpenRouterError("HTTP 503", status))).toBe(false);
    for (const message of ["ZDR violation: 503 endpoints", "No endpoints match your data policy", "item 500 exists", "invalid api key"]) {
        expect(isRetryableLlmError(new Error(message))).toBe(false);
    }
    expect(isRetryableLlmError(new OpenRouterError("busy", 429))).toBe(true);
    expect(isRetryableLlmError(new Error("HTTP 503"))).toBe(true);
});

it("cancelar no backoff não executa a próxima tentativa", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(withLlmStepRetry(async () => {
        calls++;
        throw new OpenRouterError("busy", 503);
    }, { signal: controller.signal, sleep: async () => { controller.abort(); } })).rejects.toThrow();
    expect(calls).toBe(1);
});
