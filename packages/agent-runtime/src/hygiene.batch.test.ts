import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import {
	COLLAPSE_BATCH_MAX_CHARS,
	COLLAPSE_BATCH_SIZE,
	COLLAPSE_MARKER,
	applyPromptHygiene,
	lastCollapsedIndex,
	omitOldScreenshotsInBatches,
	omitOldUserImagesInBatches,
	shouldCollapseNow,
} from "./hygiene.js";

const batch = { size: COLLAPSE_BATCH_SIZE, maxPendingChars: COLLAPSE_BATCH_MAX_CHARS };

function call(id: string): LlmMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id, type: "function", function: { name: "read_things", arguments: "{}" } }],
	};
}
const tool = (id: string, content: string): LlmMessage => ({ role: "tool", tool_call_id: id, content });

/** Conversa que cresce uma decisão por passo, com a higiene reaplicada a cada passo (como o runtime). */
function runSteps(steps: number, options: { batch?: typeof batch; size?: number }): string[][] {
	let conversation: LlmMessage[] = [
		{ role: "system", content: "static system prompt" },
		{ role: "user", content: "task" },
	];
	const requests: string[][] = [];
	for (let step = 0; step < steps; step += 1) {
		conversation = applyPromptHygiene(conversation, { collapseBatch: options.batch }).messages;
		requests.push(conversation.map((message) => JSON.stringify(message)));
		conversation.push(call(`c${step}`), tool(`c${step}`, `result ${step} `.repeat(options.size ?? 50)));
	}
	return requests;
}

/** Quantas mensagens do request anterior continuam idênticas, em bytes, como prefixo do novo. */
function stablePrefix(previous: string[], next: string[]): number {
	let i = 0;
	while (i < previous.length && i < next.length && previous[i] === next[i]) i += 1;
	return i;
}

describe("colapso em lote (L4)", () => {
	it("sem lote, o prefixo muda a todo passo (comportamento antigo)", () => {
		const requests = runSteps(10, {});
		let changed = 0;
		for (let i = 1; i < requests.length; i += 1) {
			if (stablePrefix(requests[i - 1]!, requests[i]!) < requests[i - 1]!.length) changed += 1;
		}
		expect(changed).toBeGreaterThanOrEqual(7);
	});

	it("em lote, o request anterior é prefixo exato do novo entre os lotes", () => {
		const requests = runSteps(20, { batch });
		const rewrites: number[] = [];
		for (let i = 1; i < requests.length; i += 1) {
			const previous = requests[i - 1]!;
			if (stablePrefix(previous, requests[i]!) < previous.length) rewrites.push(i);
		}
		// Só nas fronteiras de lote (1 colapso a cada COLLAPSE_BATCH_SIZE decisões).
		expect(rewrites.length).toBeLessThanOrEqual(Math.ceil(20 / COLLAPSE_BATCH_SIZE));
		expect(rewrites.length).toBeGreaterThan(0);
		for (let i = 1; i < rewrites.length; i += 1) {
			expect(rewrites[i]! - rewrites[i - 1]!).toBe(COLLAPSE_BATCH_SIZE);
		}
	});

	it("passa de lote a lote sem perder o pareamento assistant/tool", () => {
		let conversation: LlmMessage[] = [{ role: "user", content: "task" }];
		for (let step = 0; step < 13; step += 1) {
			conversation = applyPromptHygiene(conversation, { collapseBatch: batch }).messages;
			conversation.push(call(`c${step}`), tool(`c${step}`, "x".repeat(300)));
		}
		const ids = new Set(conversation.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
		const answered = new Set(conversation.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
		expect(answered).toEqual(ids);
		expect(conversation.some((m) => typeof m.content === "string" && m.content.startsWith(COLLAPSE_MARKER))).toBe(true);
	});

	it("proteção da janela: resultados grandes colapsam antes do lote fechar", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "task" },
			call("a"), tool("a", "y".repeat(40_000)),
			call("b"), tool("b", "z".repeat(40_000)),
			call("c"), tool("c", "w"),
		];
		expect(shouldCollapseNow(messages, batch)).toBe(true);
		expect(shouldCollapseNow(messages.slice(0, 3), batch)).toBe(false);
	});

	it("lastCollapsedIndex acha o fim do trecho estável", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "task" },
			call("a"), tool("a", `${COLLAPSE_MARKER}: x`),
			call("b"), tool("b", "full"),
		];
		expect(lastCollapsedIndex(messages)).toBe(2);
		expect(lastCollapsedIndex(messages.slice(0, 1))).toBeUndefined();
	});
});

describe("screenshots em lote", () => {
	const shot = (id: string): LlmMessage => ({
		role: "user",
		content: [{ type: "text", text: "tela" }, { type: "screenshot_ref", artifactId: id }],
	});
	const omittedCount = (messages: LlmMessage[]) =>
		messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "text" && p.text.startsWith("[screenshot omitted"))).length;

	it("o número de omitidas só sobe de lote em lote", () => {
		const history: LlmMessage[] = [];
		const counts: number[] = [];
		for (let i = 0; i < 12; i += 1) {
			history.push(shot(`s${i}`));
			counts.push(omittedCount(omitOldScreenshotsInBatches(history)));
		}
		expect(new Set(counts)).toEqual(new Set([0, 4, 8]));
		expect(counts).toEqual([...counts].sort((a, b) => a - b));
	});
});

describe("L4: imagens do usuário em lote", () => {
	const withImage = (id: string): LlmMessage => ({
		role: "user",
		content: [
			{ type: "text", text: `photo ${id}` },
			{ type: "image_ref", artifactId: id, name: id },
		],
	});
	const omittedCount = (messages: readonly LlmMessage[]) =>
		messages.filter((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "text" && part.text.startsWith("[image omitted"))).length;

	it("a omissão só sobe de COLLAPSE_BATCH_SIZE em COLLAPSE_BATCH_SIZE (o prefixo não muda a cada anexo)", () => {
		const messages: LlmMessage[] = [{ role: "system", content: "s" }];
		const counts: number[] = [];
		for (let i = 0; i < 4 + COLLAPSE_BATCH_SIZE * 2; i += 1) {
			messages.push(withImage(`img-${i}`));
			counts.push(omittedCount(omitOldUserImagesInBatches(messages)));
		}
		// Nunca omite além do que o modo exato omitiria, e só muda em múltiplos do lote.
		expect([...new Set(counts)]).toEqual([0, COLLAPSE_BATCH_SIZE, COLLAPSE_BATCH_SIZE * 2]);
		counts.forEach((count, index) => {
			expect(count).toBeLessThanOrEqual(Math.max(0, index + 1 - 4));
		});
	});

	it("as mensagens mais antigas são as omitidas e o texto vizinho continua", () => {
		const messages: LlmMessage[] = Array.from({ length: 4 + COLLAPSE_BATCH_SIZE }, (_, i) => withImage(`img-${i}`));
		const result = omitOldUserImagesInBatches(messages);
		expect(JSON.stringify(result[0])).toContain("[image omitted");
		expect(JSON.stringify(result[0])).toContain("photo img-0");
		expect(JSON.stringify(result.at(-1))).toContain("image_ref");
	});
});
