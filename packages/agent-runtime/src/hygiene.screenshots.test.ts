import { describe, expect, it } from "vitest";
import type { LlmContentPart, LlmMessage } from "@workspace/llm";
import { omitOldScreenshots } from "./hygiene.js";

const FULL_PNG = "data:image/png;base64,FULL";
const SMALL_JPG = "data:image/jpeg;base64,SMALL";

function step(i: number, url: string): LlmMessage[] {
	const id = `c${i}`;
	return [
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{ id, type: "function", function: { name: i % 3 === 0 ? "screenshot" : "click", arguments: "{\"x\":10,\"y\":20}" } },
			],
		},
		{ role: "tool", tool_call_id: id, content: i % 3 === 0 ? "Screenshot capturado e enviado." : "Clique em (10, 20)" },
		{
			role: "user",
			content: [
				{ type: "text", text: "Screenshot atual da tela:" },
				{ type: "image_url", image_url: { url } },
			],
		},
	];
}

function conversation(steps: number, url: string): LlmMessage[] {
	const messages: LlmMessage[] = [
		{ role: "system", content: "S".repeat(6000) },
		{ role: "user", content: "Cadastre o produto no Bling" },
	];
	for (let i = 1; i <= steps; i += 1) messages.push(...step(i, url));
	return messages;
}

const images = (messages: LlmMessage[]) =>
	messages.flatMap((m) =>
		Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : [],
	);

// Custo de imagem na Anthropic ~ largura*altura/750 tokens.
const IMAGE_TOKENS = { [FULL_PNG]: 1229, [SMALL_JPG]: 786 } as Record<string, number>;
function promptTokens(messages: LlmMessage[]): number {
	let chars = 0;
	let tokens = 0;
	for (const m of messages) {
		if (typeof m.content === "string") chars += m.content.length;
		else if (Array.isArray(m.content)) {
			for (const p of m.content as LlmContentPart[]) {
				if (p.type === "text") chars += p.text.length;
				if (p.type === "image_url") tokens += IMAGE_TOKENS[p.image_url.url] ?? 1000;
			}
		}
		if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
	}
	return Math.ceil(chars / 4) + tokens;
}

describe("omitOldScreenshots", () => {
	it("mantém só as 2 mais recentes e marca as antigas com ferramenta e passo", () => {
		const input = conversation(5, SMALL_JPG);
		const out = omitOldScreenshots(input);
		expect(images(out)).toHaveLength(2);
		const markers = out.flatMap((m) =>
			Array.isArray(m.content)
				? m.content.filter((p) => p.type === "text" && p.text.startsWith("[screenshot omitted:"))
				: [],
		) as Array<{ text: string }>;
		expect(markers).toHaveLength(3);
		expect(markers[0]?.text).toBe("[screenshot omitted: click at step 1]");
		expect(markers[2]?.text).toBe("[screenshot omitted: screenshot at step 3]");
		// as 2 últimas são as dos passos 4 e 5
		const lastTwo = out.slice(-6).filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
		expect(lastTwo).toHaveLength(2);
	});

	it("também troca screenshot_ref antigo (nem chega a ler o artefato)", () => {
		const input: LlmMessage[] = [
			{ role: "user", content: [{ type: "screenshot_ref", artifactId: "a" }] },
			{ role: "user", content: [{ type: "screenshot_ref", artifactId: "b" }] },
			{ role: "user", content: [{ type: "screenshot_ref", artifactId: "c" }] },
		];
		const out = omitOldScreenshots(input);
		expect(out[0]?.content).toEqual([
			{ type: "text", text: "[screenshot omitted: screenshot at step 0]" },
		]);
		expect(out[1]?.content).toEqual(input[1]?.content);
	});

	it("não muta a entrada e não mexe quando há 2 ou menos", () => {
		const few = conversation(2, SMALL_JPG);
		expect(omitOldScreenshots(few)).toEqual(few);
		const many = conversation(6, SMALL_JPG);
		const snapshot = JSON.stringify(many);
		omitOldScreenshots(many);
		expect(JSON.stringify(many)).toBe(snapshot);
	});

	it("medição: run de 30 passos, tokens de prompt antes (PNG cheio) vs depois (2 JPG 1024px)", () => {
		let before = 0;
		let after = 0;
		for (let n = 1; n <= 30; n += 1) {
			before += promptTokens(conversation(n, FULL_PNG));
			after += promptTokens(omitOldScreenshots(conversation(n, SMALL_JPG)));
		}
		const reduction = 1 - after / before;
		console.log(`[medição] 30 passos: antes=${before} depois=${after} redução=${(reduction * 100).toFixed(1)}%`);
		expect(reduction).toBeGreaterThan(0.6);
	});
});
