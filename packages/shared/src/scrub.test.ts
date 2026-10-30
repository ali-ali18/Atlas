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

describe("cap da prévia (modo básico) no Sentry", () => {
	const ID = "cmabc123def456ghi789jkl01";
	const CAP = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
	it("sai de request.url, transaction, breadcrumbs e mensagens, mantendo o resto do caminho", () => {
		const event = {
			request: { url: `https://atlas.test/v1/previews/${ID}/p/${CAP}/assets/app.js?v=1`, method: "GET" },
			transaction: `GET /v1/previews/${ID}/p/${CAP}/index.html`,
			breadcrumbs: [{ data: { url: `https://atlas.test/v1/previews/${ID}/p/${CAP}/data.json`, to: `/v1/previews/${ID}/p/${CAP}/x` } }],
			message: `falhou em /v1/previews/${ID}/p/${CAP}/x e em /v1/previews/${ID}/open`,
			exception: { values: [{ value: `GET /v1/previews/${ID}/p/${CAP} failed` }] },
		};
		const out = JSON.stringify(scrubSentryEvent(event));
		expect(out).not.toContain(CAP);
		expect(out).toContain(`/v1/previews/${ID}/p/:cap/assets/app.js`);
		expect(out).toContain(`/v1/previews/${ID}/open`);
		const clean = scrubSentryEvent(event);
		expect(clean.request?.url).toBe(`https://atlas.test/v1/previews/${ID}/p/:cap/assets/app.js?v=1`);
		expect(clean.transaction).toBe(`GET /v1/previews/${ID}/p/:cap/index.html`);
	});
	it("scrubString também mascara", () => {
		expect(scrubString(`x /v1/previews/${ID}/p/${CAP}/a y`)).toBe(`x /v1/previews/${ID}/p/:cap/a y`);
	});
});
