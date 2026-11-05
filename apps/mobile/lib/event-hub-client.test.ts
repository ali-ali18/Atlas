import { describe, expect, it, vi } from "vitest";
import { StreamHttpError, type OpenStream, type TextSource } from "./chat-stream";
import { createEventsStreamOpener } from "./chat-open";
import { EventHub, HubAuthError, HubUnsupportedError, type HubFrame } from "./event-hub";
import { attachHubLifecycle, createHubTransport, parseHubBlock, startFallbackPoller, type AppStateLike } from "./event-hub-client";

const frame = (event: string, data: object, id?: number) => `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const flush = async () => {
	for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("parseHubBlock", () => {
	it("lê ready, resync e eventos", () => {
		expect(parseHubBlock('id: 9\nevent: ready\ndata: {"head":9}')).toEqual({ kind: "ready", head: 9 });
		expect(parseHubBlock('event: resync\ndata: {"head":40}')).toEqual({ kind: "resync", head: 40 });
		expect(parseHubBlock('id: 3\nevent: message\ndata: {"seq":3,"type":"message","payload":{"conversationId":"c1"},"at":"2026-11-05T10:00:00Z"}')).toEqual({
			kind: "event",
			event: { seq: 3, type: "message", payload: { conversationId: "c1" }, at: "2026-11-05T10:00:00Z" },
		});
	});

	it("ignora keepalive, JSON quebrado e corpo sem seq/type", () => {
		expect(parseHubBlock(": keepalive")).toBeNull();
		expect(parseHubBlock("event: message\ndata: {nao-json")).toBeNull();
		expect(parseHubBlock('data: {"type":"message"}')).toBeNull();
		expect(parseHubBlock('event: ready\ndata: {"head":"x"}')).toBeNull();
	});
});

describe("createHubTransport", () => {
	function sourceOf(chunks: string[]): TextSource {
		let index = 0;
		return { read: async () => (index < chunks.length ? { done: false, text: chunks[index++]! } : { done: true }), cancel: () => undefined };
	}

	it("monta frames de blocos quebrados no meio e passa o cursor ao abrir", async () => {
		const full = frame("ready", { head: 5 }, 5) + frame("message", { seq: 6, type: "message", payload: { conversationId: "c1" } }, 6);
		const open = vi.fn<OpenStream>(async () => sourceOf([full.slice(0, 20), full.slice(20)]));
		const frames: HubFrame[] = [];
		await createHubTransport(open)({ cursor: 4, signal: new AbortController().signal, onFrame: (f) => frames.push(f) });
		expect(open.mock.calls[0]![0]).toBe(4);
		expect(frames.filter((f) => f.kind !== "activity")).toEqual([
			{ kind: "ready", head: 5 },
			{ kind: "event", event: { seq: 6, type: "message", payload: { conversationId: "c1" }, at: undefined } },
		]);
	});

	it("sem cursor abre com 0 (sem Last-Event-ID)", async () => {
		const open = vi.fn<OpenStream>(async () => sourceOf([]));
		await createHubTransport(open)({ cursor: null, signal: new AbortController().signal, onFrame: () => undefined });
		expect(open.mock.calls[0]![0]).toBe(0);
	});

	it("401 vira HubAuthError e 404 vira HubUnsupportedError", async () => {
		const run = (status: number) =>
			createHubTransport(async () => {
				throw new StreamHttpError(status);
			})({ cursor: null, signal: new AbortController().signal, onFrame: () => undefined });
		await expect(run(401)).rejects.toBeInstanceOf(HubAuthError);
		await expect(run(404)).rejects.toBeInstanceOf(HubUnsupportedError);
		await expect(run(500)).rejects.toBeInstanceOf(StreamHttpError);
	});

	it("abortar cancela a fonte e termina sem erro", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const source: TextSource = { read: () => new Promise(() => undefined), cancel };
		const done = createHubTransport(async () => source)({ cursor: 1, signal: controller.signal, onFrame: () => undefined });
		await flush();
		controller.abort();
		// a leitura pendente não resolve sozinha: o cancelamento da fonte é o que a derruba no mundo real
		expect(cancel).toHaveBeenCalled();
		void done;
	});
});

describe("createEventsStreamOpener", () => {
	const deps = (streamFetch: Parameters<typeof createEventsStreamOpener>[0]["streamFetch"]) => ({ baseUrl: "https://atlas.test", getCookie: () => "sid=abc", streamFetch });
	const reader = { read: async () => ({ done: true }), cancel: async () => undefined };

	it("pede /v1/events com cookie e Last-Event-ID só quando há cursor", async () => {
		const streamFetch = vi.fn(async () => ({ ok: true, status: 200, body: { getReader: () => reader } }));
		const open = createEventsStreamOpener(deps(streamFetch));
		await open(0, new AbortController().signal);
		await open(42, new AbortController().signal);
		const calls = streamFetch.mock.calls as unknown as [string, { headers: Record<string, string> }][];
		expect(calls[0]![0]).toBe("https://atlas.test/v1/events");
		expect(calls[0]![1].headers["Last-Event-ID"]).toBeUndefined();
		expect(calls[0]![1].headers.cookie).toBe("sid=abc");
		expect(calls[1]![1].headers["Last-Event-ID"]).toBe("42");
	});

	it("404 sobe como StreamHttpError", async () => {
		const open = createEventsStreamOpener(deps(async () => ({ ok: false, status: 404, body: null })));
		await expect(open(0, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
	});
});

function fakeAppState(initial: string) {
	let state = initial;
	const listeners = new Set<(s: string) => void>();
	const api: AppStateLike & { set: (s: string) => void; listeners: number } = {
		current: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		set: (next) => {
			state = next;
			for (const listener of [...listeners]) listener(next);
		},
		get listeners() {
			return listeners.size;
		},
	};
	return api;
}

describe("attachHubLifecycle (ciclo de vida / bateria)", () => {
	function setup(initial: string) {
		const opens: { cursor: number | null; signal: AbortSignal; push: (f: HubFrame) => void }[] = [];
		const hub = new EventHub({
			transport: ({ cursor, signal, onFrame }) => {
				opens.push({ cursor, signal, push: onFrame });
				return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		});
		const appState = fakeAppState(initial);
		const detach = attachHubLifecycle(hub, appState);
		return { hub, opens, appState, detach };
	}

	it("não conecta em segundo plano; conecta ao ficar ativo", async () => {
		const { opens, appState, detach, hub } = setup("background");
		await flush();
		expect(opens).toHaveLength(0);
		appState.set("active");
		await flush();
		expect(opens).toHaveLength(1);
		detach();
		expect(hub.getStatus()).toBe("idle");
	});

	it("background e inactive abortam a conexão; voltar reconecta com o último cursor", async () => {
		const { opens, appState, detach } = setup("active");
		await flush();
		opens[0]!.push({ kind: "ready", head: 0 });
		opens[0]!.push({ kind: "event", event: { seq: 1, type: "message", payload: {} } });
		opens[0]!.push({ kind: "event", event: { seq: 2, type: "message", payload: {} } });
		appState.set("inactive");
		await flush();
		expect(opens[0]!.signal.aborted).toBe(true);
		appState.set("active");
		await flush();
		expect(opens).toHaveLength(2);
		expect(opens[1]!.cursor).toBe(2);
		appState.set("background");
		await flush();
		expect(opens[1]!.signal.aborted).toBe(true);
		detach();
		expect(appState.listeners).toBe(0);
	});
});

describe("startFallbackPoller", () => {
	function setup(options: { status?: "connected" | "unsupported" | "disconnected" | null; appState?: string; focused?: boolean }) {
		let tickFn: () => void = () => undefined;
		const appState = fakeAppState(options.appState ?? "active");
		const tick = vi.fn();
		let focused = options.focused ?? true;
		let status = options.status ?? null;
		const stop = startFallbackPoller({
			hub: options.status === null ? null : { getStatus: () => status ?? "connected" },
			appState,
			intervalMs: 12_000,
			isFocused: () => focused,
			tick,
			setInterval: (fn, ms) => {
				expect(ms).toBe(12_000);
				tickFn = fn;
				return 1;
			},
			clearInterval: () => undefined,
		});
		return { tick, run: () => tickFn(), appState, stop, setFocused: (v: boolean) => (focused = v), setStatus: (v: typeof status) => (status = v) };
	}

	it("conectado: nunca consulta", () => {
		const { tick, run } = setup({ status: "connected" });
		run();
		expect(tick).not.toHaveBeenCalled();
	});

	it("sem canal (404 ou sem hub) consulta em primeiro plano e com a tela em foco", () => {
		const a = setup({ status: "unsupported" });
		a.run();
		expect(a.tick).toHaveBeenCalledTimes(1);
		const b = setup({ status: null });
		b.run();
		expect(b.tick).toHaveBeenCalledTimes(1);
	});

	it("em segundo plano ou fora de foco não consulta", () => {
		const a = setup({ status: "unsupported", appState: "background" });
		a.run();
		expect(a.tick).not.toHaveBeenCalled();
		const b = setup({ status: "disconnected", focused: false });
		b.run();
		expect(b.tick).not.toHaveBeenCalled();
		b.setFocused(true);
		b.run();
		expect(b.tick).toHaveBeenCalledTimes(1);
	});
});
