import { describe, expect, it, vi } from "vitest";
import {
	FILE_CORRECTION_MAX_OUTPUT_TOKENS,
	FILE_CORRECTION_SYSTEM,
	FILE_PROMISE_SYSTEM,
	askFileCorrection,
	askFilePromise,
	parseFileCorrection,
	shouldCheckFileCorrection,
	type FileCorrectionStreamChat,
} from "./delivery-correction.js";

const reply = (content: string | null, usage?: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number }) =>
	({ model: "cheap", message: { role: "assistant", content }, ...(usage ? { usage } : {}) }) as never;

describe("delivery-correction: quando perguntar", () => {
	const base = { hasFile: true, alreadyChecked: false, usedFraction: 0.5 };

	it("só com arquivo no run, checagem ainda não feita e orçamento abaixo de 90%", () => {
		expect(shouldCheckFileCorrection(base)).toBe(true);
		expect(shouldCheckFileCorrection({ ...base, hasFile: false })).toBe(false);
		expect(shouldCheckFileCorrection({ ...base, alreadyChecked: true })).toBe(false);
		expect(shouldCheckFileCorrection({ ...base, usedFraction: 0.9 })).toBe(false);
		expect(shouldCheckFileCorrection({ ...base, usedFraction: 0.95 })).toBe(false);
		expect(shouldCheckFileCorrection({ ...base, usedFraction: 0.89 })).toBe(true);
	});
});

describe("delivery-correction: parse estrito do JSON", () => {
	it("aceita só {fixFile:boolean}", () => {
		expect(parseFileCorrection('{"fixFile": true}')).toBe(true);
		expect(parseFileCorrection('```json\n{"fixFile":false}\n```')).toBe(false);
		expect(parseFileCorrection('{"fixFile":"true"}')).toBeNull();
		expect(parseFileCorrection("sim")).toBeNull();
		expect(parseFileCorrection("{broken")).toBeNull();
		expect(parseFileCorrection("[true]")).toBeNull();
		expect(parseFileCorrection(null)).toBeNull();
	});
});

describe("delivery-correction: a decisão vem da chamada barata, não de frases", () => {
	const ask = (streamChat: FileCorrectionStreamChat, text = "irrelevante", extra: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
		askFileCorrection({ streamChat, model: "cheap", apiKey: "k", reply: text, ...extra });

	it("true devolve fixFile e o custo da chamada", async () => {
		const streamChat = vi.fn(async () => reply('{"fixFile": true}', { promptTokens: 30, completionTokens: 5, totalTokens: 35, costUsd: 0.0001 }));
		// Texto alemão: nenhuma regex pt/en/es o reconheceria.
		const verdict = await ask(streamChat, "Ich habe im PDF zwei Fehler gefunden. Soll ich eine korrigierte Version erstellen?");
		expect(verdict?.fixFile).toBe(true);
		expect(verdict?.usage).toMatchObject({ totalTokens: 35, costUsd: 0.0001 });
		const params = streamChat.mock.calls[0]![0] as never as { messages: Array<{ content: string }>; model: string; maxOutputTokens: number; tools: unknown[] };
		expect(params.model).toBe("cheap");
		expect(params.maxOutputTokens).toBe(FILE_CORRECTION_MAX_OUTPUT_TOKENS);
		expect(params.tools).toEqual([]);
		expect(params.messages[0]!.content).toBe(FILE_CORRECTION_SYSTEM);
		expect(params.messages[1]!.content).toContain("Fehler");
	});

	it("japonês: o veredito do modelo manda", async () => {
		const verdict = await ask(async () => reply('{"fixFile": true}'), "PDFに誤りがありました。修正版を作成しましょうか？");
		expect(verdict?.fixFile).toBe(true);
	});

	it("false aceita a resposta (mesmo que o texto soe como admissão)", async () => {
		const verdict = await ask(async () => reply('{"fixFile": false}'), "Corrijo: o plano Pro custa 20. Se quiser, eu gero uma versão corrigida.");
		expect(verdict?.fixFile).toBe(false);
	});

	it("falha, JSON inválido e timeout = sem veredito (aceita a resposta)", async () => {
		expect(await ask(async () => Promise.reject(new Error("boom")))).toBeNull();
		expect(await ask(async () => reply("não sei"))).toBeNull();
		expect(await ask(async () => reply(null))).toBeNull();
		expect(await ask(() => new Promise(() => undefined), "x", { timeoutMs: 20 })).toBeNull();
	});

	it("repassa o AbortSignal do run", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		await ask(async (params) => {
			seen = params.signal;
			return reply('{"fixFile": false}');
		}, "x", { signal: controller.signal });
		controller.abort();
		expect(seen?.aborted).toBe(true);
	});
});

describe("delivery-correction: a resposta ainda promete o arquivo? (chamada barata, sem frases)", () => {
	const ask = (streamChat: FileCorrectionStreamChat, text = "Ich erstelle jetzt das PDF.") =>
		askFilePromise({ streamChat, model: "cheap", apiKey: "k", reply: text });

	it("o veredito do modelo manda, em qualquer idioma, e traz o custo", async () => {
		const streamChat = vi.fn(async () => reply('{"promisesFile": true}', { promptTokens: 20, completionTokens: 4, totalTokens: 24 }));
		const verdict = await ask(streamChat);
		expect(verdict).toMatchObject({ promisesFile: true, usage: { totalTokens: 24 } });
		const params = streamChat.mock.calls[0]![0] as never as { messages: Array<{ content: string }>; tools: unknown[] };
		expect(params.messages[0]!.content).toBe(FILE_PROMISE_SYSTEM);
		expect(params.tools).toEqual([]);
		expect((await ask(async () => reply('{"promisesFile": false}')))?.promisesFile).toBe(false);
	});

	it("falha, JSON inválido e chave errada = sem veredito", async () => {
		expect(await ask(async () => { throw new Error("down"); })).toBeNull();
		expect(await ask(async () => reply("não sei"))).toBeNull();
		expect(await ask(async () => reply('{"fixFile": true}'))).toBeNull();
	});
});
