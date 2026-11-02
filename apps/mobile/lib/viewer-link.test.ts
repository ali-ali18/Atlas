import { describe, expect, it } from "vitest";
import { parseViewerSocketUrl } from "./viewer-link";

const BASE = "https://atlas.example.com";
// Formato real do servidor (apps/api/src/routes/sandbox.ts): `path` sem barra inicial, com `?t=` do token `ws`.
function serverUrl(id: string, vt = "VT.TOKEN", ws = "WS.TOKEN") {
	const params = new URLSearchParams({ autoconnect: "1", reconnect: "true", resize: "scale", path: `v1/sandbox/sessions/${encodeURIComponent(id)}/viewer/websockify?t=${ws}` });
	return `/v1/sandbox/vt/${vt}/vnc.html?${params.toString()}`;
}

describe("endereço do WebSocket a partir do viewer-link", () => {
	it("monta wss://host/<path> com o token ws", () => {
		expect(parseViewerSocketUrl(BASE, "s1", serverUrl("s1"))).toBe("wss://atlas.example.com/v1/sandbox/sessions/s1/viewer/websockify?t=WS.TOKEN");
	});
	it("o token do caminho HTTP (vt) nunca aparece no resultado", () => {
		expect(parseViewerSocketUrl(BASE, "s1", serverUrl("s1", "SEGREDO-VT"))).not.toContain("SEGREDO-VT");
	});
	it("id com caracteres especiais volta codificado e confere com a sessão pedida", () => {
		expect(parseViewerSocketUrl(BASE, "a b", serverUrl("a b"))).toBe("wss://atlas.example.com/v1/sandbox/sessions/a%20b/viewer/websockify?t=WS.TOKEN");
	});
	it("servidor em http (desenvolvimento) vira ws", () => {
		expect(parseViewerSocketUrl("http://192.168.0.5:3001", "s1", serverUrl("s1"))).toMatch(/^ws:\/\/192\.168\.0\.5:3001\//);
	});
	it("recusa sessão diferente da pedida", () => {
		expect(parseViewerSocketUrl(BASE, "s1", serverUrl("outra"))).toBeNull();
	});
	it("recusa o que não é o formato do servidor", () => {
		const bad: unknown[] = [
			undefined,
			null,
			42,
			"",
			"https://evil.example/v1/sandbox/vt/T/vnc.html?path=v1/sandbox/sessions/s1/viewer/websockify%3Ft%3DX",
			"//evil.example/v1/sandbox/vt/T/vnc.html",
			"/v1/outra/rota",
			"/v1/sandbox/vt/T/vnc.html",
			"/v1/sandbox/vt/T/vnc.html?path=",
			"/v1/sandbox/vt/T/vnc.html?path=" + encodeURIComponent("https://evil.example/ws?t=X"),
			"/v1/sandbox/vt/T/vnc.html?path=" + encodeURIComponent("v1/sandbox/sessions/s1/viewer/websockify"),
			"/v1/sandbox/vt/T/vnc.html?path=" + encodeURIComponent("v1/sandbox/sessions/s1/viewer/websockify?t=a b"),
			"/v1/sandbox/vt/T/vnc.html?path=" + encodeURIComponent("../../etc/passwd?t=X"),
			"/v1/sandbox/vt/T/vnc.html?path=" + encodeURIComponent("v1/sandbox/sessions/s1/viewer/websockify?t=X&x=//evil"),
		];
		for (const url of bad) expect(parseViewerSocketUrl(BASE, "s1", url)).toBeNull();
	});
	it("recusa servidor salvo inválido", () => {
		expect(parseViewerSocketUrl("nao-e-url", "s1", serverUrl("s1"))).toBeNull();
		expect(parseViewerSocketUrl("ftp://atlas.example.com", "s1", serverUrl("s1"))).toBeNull();
	});
});
