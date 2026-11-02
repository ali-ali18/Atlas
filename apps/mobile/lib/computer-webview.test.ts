import { describe, expect, it } from "vitest";
import { DROP_MESSAGE, HIDE_CHROME_JS, WATCH_DROP_JS, isAllowedNavigation, originOf } from "./computer-webview";

const ORIGIN = "https://atlas.example.com";

describe("navegação da WebView do Computador", () => {
	it("aceita só a origem do servidor salvo", () => {
		expect(isAllowedNavigation(`${ORIGIN}/v1/sandbox/vt/T/vnc.html?x=1`, ORIGIN)).toBe(true);
		expect(isAllowedNavigation("https://evil.example/", ORIGIN)).toBe(false);
		expect(isAllowedNavigation("http://atlas.example.com/", ORIGIN)).toBe(false);
		expect(isAllowedNavigation("https://atlas.example.com:8443/", ORIGIN)).toBe(false);
		expect(isAllowedNavigation("https://atlas.example.com.evil.example/", ORIGIN)).toBe(false);
		expect(isAllowedNavigation("https://atlas.example.com@evil.example/", ORIGIN)).toBe(false);
	});
	it("recusa esquemas que não são http(s) e endereço inválido", () => {
		for (const url of ["data:text/html,x", "blob:https://atlas.example.com/1", "file:///etc/passwd", "javascript:alert(1)", "intent://x", "about:blank", "", "nao-e-url"]) {
			expect(isAllowedNavigation(url, ORIGIN)).toBe(false);
		}
	});
	it("sem origem do servidor nada passa", () => {
		expect(isAllowedNavigation(`${ORIGIN}/`, null)).toBe(false);
		expect(originOf("ftp://x")).toBeNull();
	});
});

describe("scripts injetados", () => {
	it("escondem a barra de controle do noVNC e deixam o fundo preto", () => {
		expect(HIDE_CHROME_JS).toContain("#noVNC_control_bar_anchor");
		expect(HIDE_CHROME_JS).toContain("background:#000");
	});
	it("avisam a queda pela classe de erro do noVNC e terminam com true", () => {
		expect(WATCH_DROP_JS).toContain("noVNC_status_error");
		expect(WATCH_DROP_JS).toContain(`postMessage('${DROP_MESSAGE}')`);
		expect(HIDE_CHROME_JS.endsWith("true;")).toBe(true);
		expect(WATCH_DROP_JS.endsWith("true;")).toBe(true);
	});
	it("são JavaScript válido", () => {
		expect(() => new Function(HIDE_CHROME_JS)).not.toThrow();
		expect(() => new Function(WATCH_DROP_JS)).not.toThrow();
	});
});
