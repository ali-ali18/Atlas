import { describe, expect, it, vi } from "vitest";
import { askJevViaChat } from "./jev-chat.js";

const questions = { a: { instructions: "?", criteria: { true: "t", false: "f" } }, b: { instructions: "?", criteria: { true: "t", false: "f" } } };
const reply = (content: string) => vi.fn(async () => ({ message: { role: "assistant" as const, content }, model: "served", usage: { promptTokens: 7 } }));

describe("askJevViaChat", () => {
  it("lê as probabilidades do JSON, mesmo com texto ao redor", async () => {
    const complete = reply('claro: {"a": 0.9, "b": 0.1} fim');
    const result = await askJevViaChat({ model: "anthropic-direct/x", apiKey: "", state: { x: 1 }, questions, timeoutMs: 2000, complete });
    expect(result.answers).toEqual({ a: 0.9, b: 0.1 });
    expect(result.model).toBe("served");
    expect(result.inputTokens).toBe(7);
    const sent = (complete.mock.calls[0] as unknown as [{ messages: Array<{ content: string }>; timeoutMs: number }])[0];
    expect(sent.timeoutMs).toBe(2000);
    expect(JSON.parse(sent.messages[1]!.content).state).toEqual({ x: 1 });
  });
  it("resposta malformada ou fora de 0..1 lança (fail-safe do chamador)", async () => {
    await expect(askJevViaChat({ model: "m", apiKey: "k", state: {}, questions, timeoutMs: 1, complete: reply("sem json") })).rejects.toThrow();
    await expect(askJevViaChat({ model: "m", apiKey: "k", state: {}, questions, timeoutMs: 1, complete: reply('{"a": 2, "b": 0.5}') })).rejects.toThrow();
    await expect(askJevViaChat({ model: "m", apiKey: "k", state: {}, questions, timeoutMs: 1, complete: reply('{"a": 0.5}') })).rejects.toThrow();
  });
});
