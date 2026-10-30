import { afterEach, expect, it, vi } from "vitest";
import { putSession, deleteSession } from "./session-store.js";
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

const record = (sessionId: string, controlPort: number) => ({
	userId: "user-a", sessionId, containerId: "c", containerName: "n", status: "running" as const,
	viewerPort: 1, controlPort, createdAt: new Date(), lastUsedAt: new Date(),
});

it("aviso pendente não vaza para a VM que reusa a porta: apagar a sessão e criar outra limpam", async () => {
	putSession(record("old", 7200));
	stubFetch({ ok: true }, { "x-atlas-tab-notice": encodeURIComponent("da VM antiga.") });
	await controlBrowserClick("sandbox", 7200, { text: "x" });
	deleteSession("old", "user-a");
	expect(takeTabNotice("sandbox", 7200)).toBeUndefined();

	await controlBrowserClick("sandbox", 7200, { text: "x" });
	putSession(record("new", 7200));
	expect(takeTabNotice("sandbox", 7200)).toBeUndefined();
	deleteSession("new", "user-a");
});

it("regravar a mesma sessão (atualizar o registro) não apaga o aviso dela", async () => {
	putSession(record("same", 7201));
	stubFetch({ ok: true }, { "x-atlas-tab-notice": encodeURIComponent("da mesma VM.") });
	await controlBrowserClick("sandbox", 7201, { text: "x" });
	putSession(record("same", 7201));
	expect(takeTabNotice("sandbox", 7201)).toBe("da mesma VM.");
	deleteSession("same", "user-a");
});

it("aviso que ninguém leu há mais de 5 min é descartado e o acumulado tem teto", async () => {
	vi.useFakeTimers();
	try {
		stubFetch({ ok: true }, { "x-atlas-tab-notice": encodeURIComponent("velho.") });
		await controlBrowserClick("sandbox", 7202, { text: "x" });
		vi.advanceTimersByTime(6 * 60_000);
		expect(takeTabNotice("sandbox", 7202)).toBeUndefined();
	} finally {
		vi.useRealTimers();
	}
	stubFetch({ ok: true }, { "x-atlas-tab-notice": encodeURIComponent("y".repeat(600)) });
	for (let i = 0; i < 6; i += 1) await controlBrowserClick("sandbox", 7203, { text: "x" });
	expect(takeTabNotice("sandbox", 7203)!.length).toBeLessThanOrEqual(1200);
});
