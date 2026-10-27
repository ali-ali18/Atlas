import { afterEach, expect, it, vi } from "vitest";
import {
	controlActivity,
	controlBrowserLinks,
	controlBrowserText,
	controlNavigate,
	controlTabClose,
	controlTabOpen,
} from "./control-client.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(json: unknown = {}) {
	const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
			calls.push({ url, headers: init.headers ?? {}, body: init.body });
			return new Response(JSON.stringify(json), { status: 200 });
		}),
	);
	return calls;
}

it("ações de browser com tabId vão para a aba (cabeçalho x-atlas-tab); sem tabId, a do pai", async () => {
	const calls = stubFetch({ url: "u", links: [] });
	await controlNavigate("h", 1, "https://a.test", { tabId: "t2" });
	await controlBrowserText("h", 1, {}, { tabId: "t2" });
	await controlBrowserLinks("h", 1, { tabId: "t2" });
	await controlBrowserText("h", 1, {}, {});
	expect(calls.map((call) => call.headers["x-atlas-tab"])).toEqual(["t2", "t2", "t2", undefined]);
});

it("abrir e fechar aba são sempre do pai (nunca herdam a aba do contexto) e levam url/tabId", async () => {
	const calls = stubFetch({ tabId: "t7", closed: true });
	expect(await controlTabOpen("h", 1, "https://a.test", { tabId: "t1" })).toEqual({ tabId: "t7", closed: true });
	await controlTabClose("h", 1, "t7", { tabId: "t1" });
	expect(calls[0].url).toMatch(/\/browser\/tab\/open$/);
	expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ url: "https://a.test" });
	expect(calls[1].url).toMatch(/\/browser\/tab\/close$/);
	expect(JSON.parse(calls[1].body ?? "{}")).toEqual({ tabId: "t7" });
	expect(calls.every((call) => call.headers["x-atlas-tab"] === undefined)).toBe(true);
});

it("controlActivity lê /idle; imagem antiga sem `busy` não finge estar ocupada", async () => {
	const calls = stubFetch({ idleMs: 5_000, busy: true, viewers: 1 });
	expect(await controlActivity("h", 1)).toEqual({ idleMs: 5_000, busy: true });
	expect(calls[0].url).toMatch(/\/idle$/);
	stubFetch({ idleMs: 90_000 });
	expect(await controlActivity("h", 1)).toEqual({ idleMs: 90_000, busy: false });
	stubFetch({});
	await expect(controlActivity("h", 1)).rejects.toThrow(/idleMs/);
});
