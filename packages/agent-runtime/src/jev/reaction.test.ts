import { describe, expect, it, vi } from "vitest";
import { BOT_REACTION_EMOJIS } from "@workspace/shared";
import type { JevAsk } from "./decide.js";
import { detectReactionOnly } from "./reaction.js";

const answering = (answers: Record<string, number>): JevAsk => async () => ({ model: "m", answers, durationMs: 1 });
const rt = (ask: JevAsk, mode: "on" | "shadow" | "off" = "on") => ({ ask, modes: { intent: mode } });

describe("detectReactionOnly (camada 2)", () => {
	it("sim com certeza reage; o emoji vem sempre do conjunto fixo", async () => {
		const plain = await detectReactionOnly({ rt: rt(answering({ no_reply: 0.97, thanks: 0.1, funny: 0.1 })), latestUserMessage: "boa essa" });
		const thanks = await detectReactionOnly({ rt: rt(answering({ no_reply: 0.97, thanks: 0.9, funny: 0.1 })), latestUserMessage: "aprecio" });
		const funny = await detectReactionOnly({ rt: rt(answering({ no_reply: 0.97, thanks: 0.1, funny: 0.9 })), latestUserMessage: "morri" });
		expect([plain, thanks, funny]).toEqual(["👍", "❤️", "😂"]);
		for (const emoji of [plain, thanks, funny]) expect(BOT_REACTION_EMOJIS).toContain(emoji);
	});

	it("incerto (abaixo de 0.9) segue o fluxo normal", async () => {
		expect(await detectReactionOnly({ rt: rt(answering({ no_reply: 0.85, thanks: 0, funny: 0 })), latestUserMessage: "hmm" })).toBeNull();
	});

	it("erro, resposta malformada e timeout viram null (run normal)", async () => {
		expect(await detectReactionOnly({ rt: rt(async () => { throw new Error("boom"); }), latestUserMessage: "ok então" })).toBeNull();
		expect(await detectReactionOnly({ rt: rt(async () => ({ model: "m", answers: { no_reply: 0.99 }, durationMs: 1 })), latestUserMessage: "ok então" })).toBeNull();
		vi.useFakeTimers();
		const pending = detectReactionOnly({ rt: rt(() => new Promise(() => undefined)), latestUserMessage: "ok então" });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await pending).toBeNull();
		vi.useRealTimers();
	});

	it("desligado, em sombra ou sem Jev nunca chama", async () => {
		const ask = vi.fn(answering({ no_reply: 1, thanks: 0, funny: 0 }));
		expect(await detectReactionOnly({ rt: rt(ask, "off"), latestUserMessage: "x" })).toBeNull();
		expect(await detectReactionOnly({ rt: rt(ask, "shadow"), latestUserMessage: "x" })).toBeNull();
		expect(await detectReactionOnly({ rt: undefined, latestUserMessage: "x" })).toBeNull();
		expect(ask).not.toHaveBeenCalled();
	});

	it("o pedido ao Jev é pequeno: só a mensagem e a última fala do assistente, cortadas", async () => {
		const ask = vi.fn(answering({ no_reply: 0, thanks: 0, funny: 0 }));
		await detectReactionOnly({ rt: rt(ask), latestUserMessage: "a".repeat(500), previousAssistantMessage: "b".repeat(900) });
		const state = ask.mock.calls[0]![0].state as { latestUserMessage: string; previousAssistantMessage: string };
		expect(state.latestUserMessage.length).toBe(200);
		expect(state.previousAssistantMessage.length).toBe(240);
	});
});
