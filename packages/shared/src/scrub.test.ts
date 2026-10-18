import { describe, expect, it } from "vitest";
import { FILTERED, scrubSentryEvent, scrubString, scrubValue } from "./scrub.js";

describe("scrubString", () => {
	it("mascara ?secret=, Bearer, chaves de provedor e PEM", () => {
		expect(scrubString("GET /v1/hooks/abc?secret=hunter2&x=1")).toBe(`GET /v1/hooks/abc?secret=${FILTERED}&x=1`);
		expect(scrubString("Authorization: Bearer abcdefghijklmnop")).toBe(`Authorization: Bearer ${FILTERED}`);
		expect(scrubString("falhou com sk-or-v1-abcdefghijklmnop1234")).toBe(`falhou com ${FILTERED}`);
		expect(scrubString("-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----")).toBe(FILTERED);
		expect(scrubString("ghp_abcdefghijklmnopqrstuvwxyz")).toBe(FILTERED);
	});

	it("não mexe em texto comum", () => {
		expect(scrubString("Falha ao salvar a memória do bot")).toBe("Falha ao salvar a memória do bot");
	});
});

describe("scrubValue", () => {
	it("filtra chaves sensíveis em qualquer profundidade, sem mutar a entrada", () => {
		const input = { headers: { Authorization: "Bearer zzzzzzzzzz", "X-Atlas-Hook-Secret": "s", "content-type": "json" }, nested: [{ apiKey: "k", ok: 1 }], token: "t" };
		const out = scrubValue(input);
		expect(out).toEqual({ headers: { Authorization: FILTERED, "X-Atlas-Hook-Secret": FILTERED, "content-type": "json" }, nested: [{ apiKey: FILTERED, ok: 1 }], token: FILTERED });
		expect(input.token).toBe("t");
	});

	it("aguenta ciclos", () => {
		const a: Record<string, unknown> = { name: "a" };
		a.self = a;
		expect(() => scrubValue(a)).not.toThrow();
	});
});

describe("scrubSentryEvent", () => {
	it("remove cookies, corpo, query e PII do usuário; mantém só o id", () => {
		const event = {
			message: "boom",
			user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
			request: {
				url: "https://app/v1/hooks/x?secret=abc123",
				cookies: { session: "s" },
				data: { password: "p" },
				query_string: "secret=abc123&a=1",
				headers: { cookie: "x=1", authorization: "Bearer aaaaaaaaaa", accept: "*/*" },
			},
			server_name: "host-1",
		};
		const out = scrubSentryEvent(event);
		expect(out.user).toEqual({ id: "u1" });
		expect(out.request?.cookies).toBeUndefined();
		expect(out.request?.data).toBeUndefined();
		expect(out.request?.url).toBe(`https://app/v1/hooks/x?secret=${FILTERED}`);
		expect(out.request?.query_string).toBe(`secret=${FILTERED}&a=1`);
		expect(out.request?.headers).toEqual({ cookie: FILTERED, authorization: FILTERED, accept: "*/*" });
		expect(out.server_name).toBeUndefined();
		expect(JSON.stringify(out)).not.toMatch(/a@b\.c|1\.2\.3\.4|hunter|abc123/);
	});
});
