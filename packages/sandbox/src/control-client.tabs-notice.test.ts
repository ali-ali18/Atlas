import { afterEach, expect, it, vi } from "vitest";
import { controlBrowserTabs, controlBrowserClick, controlScreenshot, takeTabNotice } from "./control-client.js";

afterEach(() => vi.unstubAllGlobals());

const NOTICE = 'A new tab opened: "Aula ção" — https://lms.test/aula. You are now on it.';

function stubFetch(body: unknown, headers: Record<string, string> = {}, status = 200) {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status, headers }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

it("tabs: POST /browser/tabs com a ação e devolve o resultado", async () => {
	const fetchMock = stubFetch({ action: "switch", active: { index: 2, title: "t", url: "u" } });
	const result = await controlBrowserTabs("sandbox", 7100, { action: "switch", index: 2 });
	expect(result).toEqual({ action: "switch", active: { index: 2, title: "t", url: "u" } });
	const [url, init] = fetchMock.mock.calls[0]!;
	expect(url).toBe("http://sandbox:7100/browser/tabs");
	expect(JSON.parse(String(init.body))).toEqual({ action: "switch", index: 2 });
});

it("aviso de aba nova vem no cabeçalho, é decodificado e entregue uma vez só", async () => {
	stubFetch({ ok: true }, { "x-atlas-tab-notice": encodeURIComponent(NOTICE) });
	await controlBrowserClick("sandbox", 7101, { text: "Acessar" });
	expect(takeTabNotice("sandbox", 7101)).toBe(NOTICE);
	expect(takeTabNotice("sandbox", 7101)).toBeUndefined();
});

it("aviso também chega em resposta de erro e de screenshot (binário)", async () => {
	stubFetch({ error: "boom" }, { "x-atlas-tab-notice": encodeURIComponent("first.") }, 500);
	await expect(controlBrowserClick("sandbox", 7102, { text: "x" })).rejects.toThrow(/boom/);
	vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "x-atlas-tab-notice": encodeURIComponent("second.") } })));
	await controlScreenshot("sandbox", 7102);
	expect(takeTabNotice("sandbox", 7102)).toBe("first. second.");
});

it("chamada da aba de um subagente nunca consome nem guarda o aviso do pai", async () => {
	stubFetch({ ok: true }, { "x-atlas-tab-notice": encodeURIComponent(NOTICE) });
	await controlBrowserClick("sandbox", 7103, { text: "x" }, { tabId: "t1" });
	expect(takeTabNotice("sandbox", 7103)).toBeUndefined();
});

it("cabeçalho malformado é ignorado sem derrubar a chamada", async () => {
	stubFetch({ ok: true }, { "x-atlas-tab-notice": "%E0%A4%A" });
	await expect(controlBrowserClick("sandbox", 7104, { text: "x" })).resolves.toBeTruthy();
	expect(takeTabNotice("sandbox", 7104)).toBeUndefined();
});
