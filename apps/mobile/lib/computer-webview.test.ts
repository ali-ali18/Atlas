import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { DROP_MESSAGE, HIDE_CHROME_JS, STORAGE_SHIM_JS, WATCH_DROP_JS, isAllowedNavigation, originOf } from "./computer-webview";

/** Código que simula o navegador: ler `window.<name>` lança o SecurityError de um documento em sandbox sem allow-same-origin. */
const sandboxed = (name: string, configurable = true) =>
	`Object.defineProperty(window,'${name}',{configurable:${configurable},get:function(){throw new Error("SecurityError: The document is sandboxed and lacks the 'allow-same-origin' flag.")}});`;

/** Monta um "window" no `node:vm` com `setup`, roda o shim e devolve o `window` do contexto. */
function runShim(setup: string): Record<string, any> {
	const context = vm.createContext({});
	vm.runInContext(`var window=globalThis;${setup}`, context);
	vm.runInContext(STORAGE_SHIM_JS, context);
	return vm.runInContext("window", context);
}

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
		expect(() => new Function(STORAGE_SHIM_JS)).not.toThrow();
	});
});

describe("shim de storage (documento em sandbox sem allow-same-origin)", () => {
	it("troca localStorage e sessionStorage por um Storage em memória quando a leitura lança", () => {
		const win = runShim(sandboxed("localStorage") + sandboxed("sessionStorage"));
		for (const name of ["localStorage", "sessionStorage"]) {
			const storage = win[name];
			expect(storage.length).toBe(0);
			expect(storage.getItem("a")).toBeNull();
			storage.setItem("a", "1");
			storage.setItem("b", 2);
			expect(storage.getItem("a")).toBe("1");
			expect(storage.getItem("b")).toBe("2");
			expect(storage.length).toBe(2);
			expect(storage.key(0)).toBe("a");
			expect(storage.key(1)).toBe("b");
			expect(storage.key(2)).toBeNull();
			expect(storage.key(-1)).toBeNull();
			storage.removeItem("a");
			expect(storage.getItem("a")).toBeNull();
			expect(storage.length).toBe(1);
			storage.clear();
			expect(storage.length).toBe(0);
			expect(storage.getItem("b")).toBeNull();
		}
	});
	it("os dois storages são independentes e chaves como 'toString' não vêm do protótipo", () => {
		const win = runShim(sandboxed("localStorage") + sandboxed("sessionStorage"));
		win.localStorage.setItem("x", "1");
		expect(win.sessionStorage.getItem("x")).toBeNull();
		expect(win.localStorage.getItem("toString")).toBeNull();
		expect(win.localStorage.getItem("hasOwnProperty")).toBeNull();
	});
	it("troca só o que está quebrado", () => {
		const win = runShim(sandboxed("localStorage"));
		expect(typeof win.localStorage.getItem).toBe("function");
		expect(win.sessionStorage).toBeUndefined();
	});
	it("Storage que funciona permanece intocado (mesmo objeto, mesmos dados)", () => {
		const win = runShim("window.healthy={data:{a:'1'},getItem:function(k){return this.data[k]===undefined?null:this.data[k]}};window.localStorage=window.healthy;window.sessionStorage=window.healthy;");
		expect(win.localStorage).toBe(win.healthy);
		expect(win.sessionStorage).toBe(win.healthy);
		expect(win.localStorage.getItem("a")).toBe("1");
	});
	it("se a propriedade não puder ser redefinida, não lança e fica como estava", () => {
		const context = vm.createContext({});
		vm.runInContext(`var window=globalThis;${sandboxed("localStorage", false)}`, context);
		expect(() => vm.runInContext(STORAGE_SHIM_JS, context)).not.toThrow();
		expect(() => vm.runInContext("window.localStorage", context)).toThrow("SecurityError");
	});
});
