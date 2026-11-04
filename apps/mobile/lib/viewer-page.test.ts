import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { NOVNC_BUNDLE } from "./novnc-bundle.generated";
import { BRIDGE_JS, buildViewerHtml, isAllowedViewerNavigation, viewerCsp, viewerSocketOrigin } from "./viewer-page";

describe("CSP da página do viewer", () => {
	it("conecta só ao WebSocket do host do servidor", () => {
		expect(viewerCsp("https://atlas.example.com")).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src wss://atlas.example.com; img-src data: blob:");
		expect(viewerCsp("https://atlas.example.com:8443/qualquer/caminho?x=1")).toContain("connect-src wss://atlas.example.com:8443;");
	});
	it("servidor em http (desenvolvimento) usa ws", () => {
		expect(viewerSocketOrigin("http://192.168.0.10:3001")).toBe("ws://192.168.0.10:3001");
	});
	it("aceita IPv6 entre colchetes", () => {
		expect(viewerSocketOrigin("https://[2001:db8::1]:8443")).toBe("wss://[2001:db8::1]:8443");
	});
	it("não deixa nada de fora ('none' no resto, sem * nem https:)", () => {
		const csp = viewerCsp("https://atlas.example.com") as string;
		expect(csp).not.toContain("*");
		expect(csp).not.toMatch(/(?:script|connect|style|img)-src[^;]*https?:/);
		expect(csp).toContain("default-src 'none'");
	});
	it("recusa endereço inválido (formato)", () => {
		for (const url of ["", "não é url", "ftp://atlas.example.com", "file:///x", "javascript:alert(1)", "https://user:pass@atlas.example.com", "https://atlas.example.com;script-src *"]) {
			expect(viewerCsp(url)).toBeNull();
		}
		// O host com ; ou espaço nem chega a ser host válido para o URL; checa também o formato direto:
		expect(viewerSocketOrigin("https://a b.example.com")).toBeNull();
		expect(viewerSocketOrigin("https://exa_mple.com")).toBeNull();
	});
});

describe("navegação da WebView do viewer", () => {
	it("só a carga da própria página (about:blank) passa", () => {
		expect(isAllowedViewerNavigation("about:blank")).toBe(true);
	});
	it("qualquer outra navegação é recusada", () => {
		for (const url of ["https://atlas.example.com/", "http://x", "data:text/html,x", "blob:https://x/1", "file:///etc/passwd", "javascript:alert(1)", "intent://x", "about:srcdoc", "", "about:blank#x"]) {
			expect(isAllowedViewerNavigation(url)).toBe(false);
		}
	});
});

describe("HTML do viewer", () => {
	const html = buildViewerHtml("https://atlas.example.com") as string;
	it("tem a CSP, a ponte, o bundle como módulo e o alvo", () => {
		expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'');
		expect(html).toContain('<div id="screen"></div>');
		expect(html).toContain(`<script type="module">${NOVNC_BUNDLE}</script>`);
		expect(html).toContain(BRIDGE_JS);
	});
	it("só tem dois scripts (ponte e módulo) e nenhum endereço de servidor além da CSP", () => {
		expect(html.match(/<\/script/gi)).toHaveLength(2);
		expect(html).not.toMatch(/<script[^>]+src=/i);
		expect(html).not.toContain("viewer/websockify");
	});
	it("endereço inválido não gera página", () => {
		expect(buildViewerHtml("nao-e-url")).toBeNull();
	});
	it("o bundle não toca em localStorage, sessionStorage nem cookie", () => {
		expect(NOVNC_BUNDLE).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
	});
});

describe("ponte da página (executada num ambiente simulado)", () => {
	function setup() {
		const posts: unknown[] = [];
		const sent: number[] = [];
		const listeners: Record<string, (e?: unknown) => void> = {};
		const instances: Array<{ url: string; props: Record<string, unknown>; disconnected: boolean }> = [];
		class RFB {
			url: string;
			props: Record<string, unknown> = {};
			disconnected = false;
			constructor(_target: unknown, url: string) {
				this.url = url;
				instances.push(this as never);
			}
			addEventListener(name: string, fn: (e?: unknown) => void) {
				listeners[`${instances.indexOf(this as never)}:${name}`] = fn;
			}
			sendKey(keysym: number) {
				sent.push(keysym);
			}
			disconnect() {
				this.disconnected = true;
			}
			set scaleViewport(v: boolean) { this.props.scaleViewport = v; }
			set clipViewport(v: boolean) { this.props.clipViewport = v; }
			set resizeSession(v: boolean) { this.props.resizeSession = v; }
			set viewOnly(v: boolean) { this.props.viewOnly = v; }
			set showDotCursor(v: boolean) { this.props.showDotCursor = v; }
			set background(v: string) { this.props.background = v; }
		}
		const window: Record<string, any> = { ReactNativeWebView: { postMessage: (m: string) => posts.push(JSON.parse(m)) } };
		const context = vm.createContext({ window, document: { getElementById: () => ({}) }, setTimeout: (fn: () => void) => { fn(); return 0; }, JSON, Array, Math });
		vm.runInContext(BRIDGE_JS, context);
		return { window, posts, sent, listeners, instances, RFB };
	}
	it("ready, connect com as opções certas e eventos para o app", () => {
		const { window, posts, listeners, instances, RFB } = setup();
		window.NoVNC = { RFB };
		window.__bridge.ready();
		expect(posts).toEqual([{ t: "ready" }]);
		window.__bridge.connect("wss://h/p?t=x", true);
		expect(instances[0]?.url).toBe("wss://h/p?t=x");
		expect(instances[0]?.props).toMatchObject({ scaleViewport: true, clipViewport: false, resizeSession: false, viewOnly: true, showDotCursor: false });
		listeners["0:connect"]?.();
		listeners["0:disconnect"]?.({ detail: { clean: false } });
		expect(posts.slice(1)).toEqual([{ t: "connected" }, { t: "disconnected", clean: false }]);
	});
	it("assumir o controle liga o toque e o ponto; soltar volta", () => {
		const { window, instances, RFB } = setup();
		window.NoVNC = { RFB };
		window.__bridge.connect("wss://h/p", true);
		window.__bridge.setViewOnly(false);
		expect(instances[0]?.props).toMatchObject({ viewOnly: false, showDotCursor: true });
		window.__bridge.setViewOnly(true);
		expect(instances[0]?.props).toMatchObject({ viewOnly: true, showDotCursor: false });
	});
	it("reconectar fecha a anterior e ignora eventos da conexão velha", () => {
		const { window, posts, listeners, instances, RFB } = setup();
		window.NoVNC = { RFB };
		window.__bridge.connect("wss://h/a", true);
		window.__bridge.connect("wss://h/b", true);
		expect(instances[0]?.disconnected).toBe(true);
		listeners["0:disconnect"]?.({ detail: { clean: true } });
		expect(posts).toEqual([]);
		listeners["1:connect"]?.();
		expect(posts).toEqual([{ t: "connected" }]);
	});
	it("manda só keysyms válidos, em ordem, com sendKey(keysym, null)", () => {
		const { window, sent, RFB } = setup();
		window.NoVNC = { RFB };
		window.__bridge.connect("wss://h/p", false);
		window.__bridge.keys([97, 0xff0d, -1, 0, 1.5, "a", 0x01000000 + 0x1f600, 0x7fffffff]);
		expect(sent).toEqual([97, 0xff0d, 0x01000000 + 0x1f600]);
		window.__bridge.keys("não é lista");
		expect(sent).toHaveLength(3);
	});
	it("conexão pedida antes do noVNC carregar espera o ready", () => {
		const { window, posts, instances, RFB } = setup();
		window.__bridge.connect("wss://h/p", true);
		expect(instances).toHaveLength(0);
		window.NoVNC = { RFB };
		window.__bridge.ready();
		expect(instances).toHaveLength(1);
		expect(posts).toEqual([{ t: "ready" }]);
	});
});
