import { describe, expect, it } from "vitest";
import { SERVER_URL_ERRORS, isLocalHost, normalizeServerUrl } from "./server-url";

const prod = { dev: false };
const dev = { dev: true };

describe("normalizeServerUrl", () => {
	it("recusa vazio e só espaços", () => {
		expect(normalizeServerUrl("", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.empty });
		expect(normalizeServerUrl("   ", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.empty });
	});

	it("aceita https e tira a barra final", () => {
		expect(normalizeServerUrl("https://atlas.example.com/", prod)).toEqual({ ok: true, url: "https://atlas.example.com" });
		expect(normalizeServerUrl("https://atlas.example.com///", prod)).toEqual({ ok: true, url: "https://atlas.example.com" });
	});

	it("assume https quando não há esquema e normaliza caixa do host", () => {
		expect(normalizeServerUrl("  Atlas.Example.com  ", prod)).toEqual({ ok: true, url: "https://atlas.example.com" });
	});

	it("mantém porta e caminho, descarta query e fragmento", () => {
		expect(normalizeServerUrl("https://example.com:8443/atlas/?a=1#x", prod)).toEqual({
			ok: true,
			url: "https://example.com:8443/atlas",
		});
	});

	it("recusa http fora de dev, mesmo em localhost", () => {
		expect(normalizeServerUrl("http://atlas.example.com", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.insecure });
		expect(normalizeServerUrl("http://localhost:3000", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.insecure });
	});

	it("em dev aceita http só para localhost e rede local", () => {
		expect(normalizeServerUrl("http://localhost:4000", dev)).toEqual({ ok: true, url: "http://localhost:4000" });
		expect(normalizeServerUrl("http://192.168.0.12:4000/", dev)).toEqual({ ok: true, url: "http://192.168.0.12:4000" });
		expect(normalizeServerUrl("http://10.0.2.2:4000", dev)).toEqual({ ok: true, url: "http://10.0.2.2:4000" });
		expect(normalizeServerUrl("http://atlas.example.com", dev)).toEqual({ ok: false, error: SERVER_URL_ERRORS.insecure });
		expect(normalizeServerUrl("http://8.8.8.8", dev)).toEqual({ ok: false, error: SERVER_URL_ERRORS.insecure });
	});

	it("em dev, host local sem esquema vira http", () => {
		expect(normalizeServerUrl("localhost:4000", dev)).toEqual({ ok: true, url: "http://localhost:4000" });
		expect(normalizeServerUrl("192.168.1.5:4000", dev)).toEqual({ ok: true, url: "http://192.168.1.5:4000" });
		expect(normalizeServerUrl("localhost:4000", prod)).toEqual({ ok: true, url: "https://localhost:4000" });
	});

	it("recusa esquemas que não são http(s)", () => {
		expect(normalizeServerUrl("ftp://example.com", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.protocol });
		expect(normalizeServerUrl("javascript://example.com", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.protocol });
	});

	it("recusa texto que não é endereço", () => {
		expect(normalizeServerUrl("não é um endereço", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.invalid });
		expect(normalizeServerUrl("https://", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.invalid });
		expect(normalizeServerUrl("atlas", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.invalid });
	});

	it("recusa usuário e senha no endereço", () => {
		expect(normalizeServerUrl("https://user:pass@example.com", prod)).toEqual({ ok: false, error: SERVER_URL_ERRORS.credentials });
	});
});

describe("isLocalHost", () => {
	it("reconhece loopback, LAN e .local", () => {
		for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.1", "meu-pc.local", "[::1]"]) {
			expect(isLocalHost(host)).toBe(true);
		}
	});

	it("recusa nome que só começa como IP privado", () => {
		for (const host of ["10.evil.com", "192.168.evil.com", "127.evil.com", "10.0.0.1.evil.com"]) {
			expect(isLocalHost(host)).toBe(false);
			expect(normalizeServerUrl(`http://${host}`, dev)).toEqual({ ok: false, error: SERVER_URL_ERRORS.insecure });
		}
	});

	it("octeto fora de 0-255 ou IP incompleto não é IP privado", () => {
		expect(isLocalHost("10.0.0.256")).toBe(false);
		expect(isLocalHost("192.168.1")).toBe(false);
	});

	it("não confunde IP público nem faixa 172 fora da LAN", () => {
		for (const host of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "example.com", "192.169.0.1"]) {
			expect(isLocalHost(host)).toBe(false);
		}
	});
});
