import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatWithTools, type ToolIntent } from "./chat-tools.js";

const enc = new TextEncoder();
const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const call = (index: number, part: { id?: string; name?: string; arguments?: string }) =>
	frame({ tool_calls: [{ index, ...(part.id ? { id: part.id } : {}), function: { ...(part.name ? { name: part.name } : {}), ...(part.arguments !== undefined ? { arguments: part.arguments } : {}) } }] });

function stub(chunks: string[], { failAfter }: { failAfter?: boolean } = {}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			let i = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (i < chunks.length) return void controller.enqueue(enc.encode(chunks[i++]));
					if (failAfter) return void controller.error(new Error("stream caiu"));
					controller.close();
				},
			});
			return new Response(body, { status: 200 });
		}),
	);
}

async function run(chunks: string[], options?: { failAfter?: boolean }) {
	stub([...chunks, ...(options?.failAfter ? [] : ["data: [DONE]\n\n"])], options);
	const intents: ToolIntent[] = [];
	const result = await streamChatWithTools(
		{ messages: [{ role: "user", content: "oi" }], model: "test", apiKey: "k", tools: [] },
		{ onToolIntent: (intent) => intents.push(intent) },
	);
	return { intents, result };
}

describe("onToolIntent no stream de tools", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("dispara uma vez, no primeiro chunk com nome, antes dos argumentos", async () => {
		const { intents, result } = await run([
			call(0, { id: "c1", name: "write_file", arguments: "" }),
			call(0, { arguments: '{"path":"/seg' }),
			call(0, { arguments: 'redo.txt","content":"x"}' }),
		]);
		expect(intents).toEqual([{ index: 0, id: "c1", name: "write_file" }]);
		expect(result.message.tool_calls?.[0]?.function.arguments).toBe('{"path":"/segredo.txt","content":"x"}');
	});

	it("o evento nunca carrega argumentos", async () => {
		const { intents } = await run([call(0, { id: "c1", name: "run_code", arguments: '{"code":"token=abc"}' })]);
		expect(JSON.stringify(intents)).not.toContain("abc");
		expect(Object.keys(intents[0]!).sort()).toEqual(["id", "index", "name"]);
	});

	it("vários tool_calls paralelos: um intent por index, mesmo intercalados", async () => {
		const { intents } = await run([
			call(0, { id: "a", name: "web_search", arguments: '{"q"' }),
			call(1, { id: "b", name: "read_file", arguments: "{" }),
			call(0, { arguments: ':"x"}' }),
			call(1, { arguments: "}" }),
		]);
		expect(intents.map((i) => [i.index, i.name])).toEqual([[0, "web_search"], [1, "read_file"]]);
	});

	it("nome só chega num chunk posterior (id e argumentos antes): dispara quando o nome aparece, uma vez", async () => {
		const { intents } = await run([
			call(0, { id: "c9", arguments: "" }),
			call(0, { arguments: '{"a"' }),
			call(0, { name: "edit_file", arguments: ":1}" }),
			call(0, { name: "edit_file", arguments: "" }),
		]);
		expect(intents).toEqual([{ index: 0, id: "c9", name: "edit_file" }]);
	});

	it("tool sem nome nunca vira intent (nem chamada)", async () => {
		const { intents, result } = await run([call(0, { id: "x", arguments: "{}" })]);
		expect(intents).toEqual([]);
		expect(result.message.tool_calls).toBeUndefined();
	});

	it("sem tool_calls: nenhum intent e o handler é opcional", async () => {
		const { intents } = await run([frame({ content: "oi" })]);
		expect(intents).toEqual([]);
		stub([frame({ content: "ok" }), call(0, { id: "z", name: "x", arguments: "{}" }), "data: [DONE]\n\n"]);
		await expect(streamChatWithTools({ messages: [{ role: "user", content: "oi" }], model: "t", apiKey: "k", tools: [] })).resolves.toBeDefined();
	});

	it("stream que cai depois do nome: o intent já saiu e o erro propaga (sem resultado parcial)", async () => {
		const intents: ToolIntent[] = [];
		stub([call(0, { id: "c1", name: "write_file", arguments: '{"con' })], { failAfter: true });
		await expect(
			streamChatWithTools({ messages: [{ role: "user", content: "oi" }], model: "t", apiKey: "k", tools: [], maxRetries: 0 } as never, { onToolIntent: (i) => intents.push(i) }),
		).rejects.toBeDefined();
		expect(intents.length).toBeGreaterThanOrEqual(1);
		expect(intents.every((i) => i.name === "write_file")).toBe(true);
	});

	it("callback que lança não derruba o stream nem perde a chamada", async () => {
		stub([call(0, { id: "c1", name: "write_file", arguments: '{"a":1}' }), "data: [DONE]\n\n"]);
		const result = await streamChatWithTools(
			{ messages: [{ role: "user", content: "oi" }], model: "t", apiKey: "k", tools: [] },
			{ onToolIntent: () => { throw new Error("boom"); } },
		);
		expect(result.message.tool_calls?.[0]?.function).toEqual({ name: "write_file", arguments: '{"a":1}' });
	});

	it("cancelado pelo usuário: propaga o abort", async () => {
		const controller = new AbortController();
		vi.stubGlobal("fetch", vi.fn(async () => {
			const body = new ReadableStream<Uint8Array>({
				pull(c) {
					c.enqueue(enc.encode(call(0, { id: "c1", name: "write_file", arguments: "{" })));
					controller.abort();
					return new Promise(() => undefined);
				},
			});
			return new Response(body, { status: 200 });
		}));
		const intents: ToolIntent[] = [];
		await expect(
			streamChatWithTools({ messages: [{ role: "user", content: "oi" }], model: "t", apiKey: "k", tools: [], signal: controller.signal }, { onToolIntent: (i) => intents.push(i) }),
		).rejects.toBeDefined();
		expect(intents.length).toBeLessThanOrEqual(1);
	});
});
