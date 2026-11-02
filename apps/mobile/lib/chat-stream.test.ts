import { describe, expect, it, vi } from "vitest";
import { backoff, followRun, isStreamIdle, SseBuffer, sourceFromReader, sourceFromXhr, StreamHttpError, type TextSource } from "./chat-stream";

const block = (id: number, event: object) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
const delta = (id: number, text: string) => block(id, { type: "assistant_delta", id: "s", delta: text });

function fakeSource(chunks: string[], end: "done" | "throw" = "done"): TextSource {
	let index = 0;
	return {
		read: async () => {
			if (index < chunks.length) return { done: false, text: chunks[index++]! };
			if (end === "throw") throw new Error("caiu");
			return { done: true };
		},
		cancel: () => undefined,
	};
}

const noSleep = async () => undefined;

describe("SseBuffer", () => {
	it("junta pedaços e só entrega eventos completos", () => {
		const buffer = new SseBuffer();
		expect(buffer.push("id: 1\ndata: {\"a\"")).toEqual([]);
		expect(buffer.push(":1}\n\nid: 2\n")).toEqual(['id: 1\ndata: {"a":1}']);
		expect(buffer.push("data: {}\n\n")).toEqual(["id: 2\ndata: {}"]);
	});
	it("aceita CRLF", () => {
		expect(new SseBuffer().push("id: 1\r\ndata: {}\r\n\r\n")).toEqual(["id: 1\ndata: {}"]);
	});
});

describe("followRun", () => {
	it("aplica cada evento uma vez, guarda o cursor e para no fim do run", async () => {
		const events: unknown[] = [];
		const cursors: number[] = [];
		const result = await followRun({
			open: async () => fakeSource([delta(1, "Olá"), delta(2, " mundo"), block(3, { type: "done", message: { role: "assistant", content: "" }, model: "m" })]),
			after: 0,
			signal: new AbortController().signal,
			onEvent: (event) => events.push(event),
			onCursor: (seq) => cursors.push(seq),
			runStatus: async () => "running",
			sleep: noSleep,
		});
		expect(result).toBe("boundary");
		expect(events).toHaveLength(3);
		expect(cursors).toEqual([1, 2, 3]);
	});
	it("a conexão cai no meio: reconecta do cursor e não repete o que já foi aplicado", async () => {
		const opened: number[] = [];
		const texts: string[] = [];
		const sources = [fakeSource([delta(1, "A"), delta(2, "B")], "throw"), fakeSource([delta(2, "B"), delta(3, "C"), block(4, { type: "done", message: { role: "assistant", content: "" }, model: "m" })])];
		const result = await followRun({
			open: async (cursor) => {
				opened.push(cursor);
				return sources.shift()!;
			},
			after: 0,
			signal: new AbortController().signal,
			onEvent: (event) => {
				if (event.type === "assistant_delta") texts.push(event.delta);
			},
			runStatus: async () => "running",
			sleep: noSleep,
		});
		expect(result).toBe("boundary");
		expect(opened).toEqual([0, 2]);
		expect(texts.join("")).toBe("ABC");
	});
	it("retoma de um cursor guardado e ignora ids menores ou iguais", async () => {
		const seen: number[] = [];
		await followRun({
			open: async () => fakeSource([delta(5, "x"), delta(6, "y"), block(7, { type: "cancelled" })]),
			after: 5,
			signal: new AbortController().signal,
			onEvent: () => undefined,
			onCursor: (seq) => seen.push(seq),
			runStatus: async () => null,
			sleep: noSleep,
		});
		expect(seen).toEqual([6, 7]);
	});
	it("a conexão acaba e o run já terminou no servidor: para sem reconectar", async () => {
		const open = vi.fn(async () => fakeSource([delta(1, "x")]));
		const result = await followRun({ open, after: 0, signal: new AbortController().signal, onEvent: () => undefined, runStatus: async () => "completed", sleep: noSleep });
		expect(result).toBe("terminal");
		expect(open).toHaveBeenCalledTimes(1);
	});
	it("404 é run que não existe mais; outro erro HTTP sobe", async () => {
		const base = { after: 0, signal: new AbortController().signal, onEvent: () => undefined, runStatus: async () => null, sleep: noSleep };
		expect(await followRun({ ...base, open: async () => Promise.reject(new StreamHttpError(404)) })).toBe("gone");
		await expect(followRun({ ...base, open: async () => Promise.reject(new StreamHttpError(401)) })).rejects.toMatchObject({ status: 401 });
	});
	it("falha de rede ao abrir: espera e tenta de novo", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const result = await followRun({
			open: async () => {
				calls += 1;
				if (calls < 3) throw new TypeError("Network request failed");
				return fakeSource([block(1, { type: "done", message: { role: "assistant", content: "" }, model: "m" })]);
			},
			after: 0,
			signal: new AbortController().signal,
			onEvent: () => undefined,
			runStatus: async () => "running",
			sleep: async (ms) => void sleeps.push(ms),
		});
		expect(result).toBe("boundary");
		expect(calls).toBe(3);
		expect(sleeps).toEqual([backoff(1), backoff(2)]);
	});
	it("voltar do segundo plano derruba a conexão e reconecta já, do cursor", async () => {
		const opened: number[] = [];
		let wake: (() => void) | null = null;
		const hanging: TextSource = {
			read: () => new Promise((_resolve, reject) => void (wake = () => reject(new Error("abortada")))),
			cancel: () => undefined,
		};
		const sources: TextSource[] = [hanging, fakeSource([block(1, { type: "cancelled" })])];
		const sleeps: number[] = [];
		const promise = followRun({
			open: async (cursor, signal) => {
				opened.push(cursor);
				const next = sources.shift()!;
				if (next === hanging) signal.addEventListener("abort", () => wake?.());
				return next;
			},
			after: 0,
			signal: new AbortController().signal,
			onEvent: () => undefined,
			runStatus: async () => "running",
			subscribeResume: (callback) => {
				setTimeout(callback, 5);
				return () => undefined;
			},
			sleep: async (ms) => void sleeps.push(ms),
		});
		expect(await promise).toBe("boundary");
		expect(opened).toEqual([0, 0]);
		expect(sleeps).toEqual([]);
	});
	it("o vigia derruba a conexão em silêncio (sem keepalive) e reconecta", async () => {
		let now = 0;
		let wake: (() => void) | null = null;
		const silent: TextSource = { read: () => new Promise((_resolve, reject) => void (wake = () => reject(new Error("abortada")))), cancel: () => undefined };
		const sources = [silent, fakeSource([block(1, { type: "cancelled" })])];
		let opens = 0;
		const result = await followRun({
			open: async (_cursor, signal) => {
				opens += 1;
				const next = sources.shift()!;
				if (next === silent) {
					signal.addEventListener("abort", () => wake?.());
					setTimeout(() => (now = 50_000), 1);
				}
				return next;
			},
			after: 0,
			signal: new AbortController().signal,
			onEvent: () => undefined,
			runStatus: async () => "running",
			now: () => now,
			watchMs: 5,
			sleep: noSleep,
		});
		expect(result).toBe("boundary");
		expect(opens).toBe(2);
	});
	it("cancelar o sinal para na hora", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await followRun({ open: async () => fakeSource([]), after: 0, signal: controller.signal, onEvent: () => undefined, runStatus: async () => null, sleep: noSleep })).toBe("aborted");
	});
});

describe("fontes de texto", () => {
	it("isStreamIdle e backoff", () => {
		expect(isStreamIdle(0, 39_999)).toBe(false);
		expect(isStreamIdle(0, 40_000)).toBe(true);
		expect([1, 2, 3, 4, 5, 9].map(backoff)).toEqual([800, 1600, 3200, 6400, 6400, 6400]);
	});
	it("sourceFromReader decodifica UTF-8 partido entre pedaços", async () => {
		const bytes = new TextEncoder().encode("é");
		const queue = [bytes.slice(0, 1), bytes.slice(1)];
		const source = sourceFromReader({ read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true }), cancel: async () => undefined });
		const parts: string[] = [];
		for (let chunk = await source.read(); !chunk.done; chunk = await source.read()) parts.push(chunk.text);
		expect(parts.join("")).toBe("é");
	});
	it("sourceFromXhr entrega só o que chegou de novo e termina com o pedido", async () => {
		const xhr = { responseText: "", readyState: 3, status: 200, onprogress: null as null | (() => void), onreadystatechange: null as null | (() => void), onerror: null as null | (() => void), onabort: null as null | (() => void), abort: () => undefined };
		const source = sourceFromXhr(xhr);
		xhr.responseText = "ab";
		expect(await source.read()).toEqual({ done: false, text: "ab" });
		const next = source.read();
		xhr.responseText = "abcd";
		xhr.onprogress?.();
		expect(await next).toEqual({ done: false, text: "cd" });
		const end = source.read();
		xhr.readyState = 4;
		xhr.onreadystatechange?.();
		expect(await end).toEqual({ done: true });
	});
	it("sourceFromXhr: erro de rede lança para o laço reconectar", async () => {
		const xhr = { responseText: "", readyState: 3, status: 200, onprogress: null as null | (() => void), onreadystatechange: null as null | (() => void), onerror: null as null | (() => void), onabort: null as null | (() => void), abort: () => undefined };
		const source = sourceFromXhr(xhr);
		const pending = source.read();
		xhr.onerror?.();
		await expect(pending).rejects.toThrow();
	});
});
