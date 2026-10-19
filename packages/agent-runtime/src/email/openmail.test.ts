import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOpenMailProvider } from "./openmail.js";
import { EmailProviderError } from "./provider.js";

const KEY = { apiKey: "om_FAKE_KEY_FOR_TESTS_ONLY" };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
	const calls: Call[] = [];
	const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
		calls.push({ url, method: init.method, headers: init.headers, body: init.body });
		const next = responses.shift() ?? { status: 200, body: {} };
		const status = next.status ?? 200;
		return { ok: status >= 200 && status < 300, status, text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)) };
	};
	return { fetchFn, calls };
}

describe("openmail: chamadas", () => {
	it("cria a caixa com bearer, nome válido e webhook", async () => {
		const { fetchFn, calls } = fakeFetch([{ status: 201, body: { id: "inb_1", address: "Bot-ab12@openmail.sh", webhookSecret: "whsec_1" } }]);
		const provider = createOpenMailProvider({ fetchFn });
		const inbox = await provider.createInbox(KEY, { displayName: "Atendente Ação", nameHint: "Atendente Ação", webhookUrl: "https://x.example/v1/email/inbound/m1?t=tok" });
		expect(inbox).toEqual({ inboxId: "inb_1", address: "bot-ab12@openmail.sh", webhookSecret: "whsec_1" });
		expect(calls[0]!.url).toBe("https://api.openmail.sh/v1/inboxes");
		expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY.apiKey}`);
		const body = JSON.parse(calls[0]!.body!);
		expect(body.mailboxName).toMatch(/^[a-z0-9-]{3,30}$/);
		expect(body.webhookUrl).toContain("/v1/email/inbound/m1");
	});

	it("envia com Idempotency-Key e threadId", async () => {
		const { fetchFn, calls } = fakeFetch([{ body: { messageId: "m1", threadId: "t1", providerMessageId: "<p@x>", status: "sent" } }]);
		const provider = createOpenMailProvider({ fetchFn });
		const result = await provider.send(KEY, { inboxId: "inb_1", to: "a@b.co", subject: "Re: x", body: "oi", threadId: "t1", idempotencyKey: "k1" });
		expect(result).toEqual({ messageId: "<p@x>", threadId: "t1", status: "sent" });
		expect(calls[0]!.url).toBe("https://api.openmail.sh/v1/inboxes/inb_1/send");
		expect(calls[0]!.headers["Idempotency-Key"]).toBe("k1");
		expect(JSON.parse(calls[0]!.body!)).toMatchObject({ to: "a@b.co", subject: "Re: x", body: "oi", threadId: "t1" });
	});

	it("lista mensagens e normaliza", async () => {
		const { fetchFn, calls } = fakeFetch([{ body: { data: [{ id: "1", threadId: "t", direction: "inbound", fromAddr: "A <a@b.co>", toAddr: "bot@openmail.sh", subject: "S", bodyText: "corpo", createdAt: "2026-10-18T10:00:00Z" }], total: 1 } }]);
		const provider = createOpenMailProvider({ fetchFn });
		const list = await provider.listMessages(KEY, "inb_1", { limit: 5, direction: "in" });
		expect(calls[0]!.url).toContain("direction=inbound");
		expect(list[0]).toMatchObject({ id: "1", direction: "in", from: "a@b.co", to: ["bot@openmail.sh"], body: "corpo" });
	});

	it("erros viram mensagens fixas (sem vazar o corpo do upstream)", async () => {
		const provider = createOpenMailProvider({ fetchFn: fakeFetch([{ status: 401, body: { error: "key om_FAKE_KEY invalid" } }]).fetchFn });
		await expect(provider.deleteInbox(KEY, "x")).rejects.toMatchObject({ code: "auth_failed" });
		const limited = createOpenMailProvider({ fetchFn: fakeFetch([{ status: 429 }]).fetchFn });
		await expect(limited.deleteInbox(KEY, "x")).rejects.toBeInstanceOf(EmailProviderError);
		try {
			await provider.deleteInbox(KEY, "x");
		} catch (error) {
			expect(String((error as Error).message)).not.toContain("om_FAKE");
		}
	});
});

describe("openmail: webhook", () => {
	const secret = "whsec_test";
	const now = new Date("2026-10-18T12:00:00Z");
	const ts = String(Math.floor(now.getTime() / 1000));
	const payload = {
		event: "message.received",
		event_id: "evt_1",
		occurred_at: "2026-10-18T12:00:00Z",
		inbox_id: "inb_1",
		thread_id: "thr_1",
		message: {
			id: "msg_1",
			from: "Ana <ana@empresa.com>",
			to: ["bot@openmail.sh"],
			subject: "Cotação",
			body_text: "me manda o preço",
			attachments: [{ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, url: "https://f", parsedText: "texto do pdf", extractionMethod: "pdf" }],
			received_at: "2026-10-18T12:00:00Z",
		},
	};
	const sign = (body: string, timestamp = ts, key = secret) => createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
	const provider = createOpenMailProvider({ fetchFn: fakeFetch([]).fetchFn });
	const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

	it("aceita assinatura válida e normaliza o evento", () => {
		const raw = JSON.stringify(payload);
		const result = provider.verifyAndParseWebhook({ rawBody: raw, headers: headers({ "x-timestamp": ts, "x-signature": sign(raw), "x-event-id": "evt_1" }), secret, now });
		expect(result).toMatchObject({ ok: true, event: { eventId: "evt_1", providerMessageId: "msg_1", threadId: "thr_1", from: "ana@empresa.com", subject: "Cotação", body: "me manda o preço" } });
		if (result.ok && result.event) expect(result.event.attachments[0]).toMatchObject({ filename: "a.pdf", text: "texto do pdf" });
	});

	it("aceita o prefixo sha256= e rejeita assinatura errada, corpo adulterado, segredo errado e janela vencida", () => {
		const raw = JSON.stringify(payload);
		const ok = provider.verifyAndParseWebhook({ rawBody: raw, headers: headers({ "x-timestamp": ts, "x-signature": `sha256=${sign(raw)}` }), secret, now });
		expect(ok.ok).toBe(true);
		const bad = (sig: string, body = raw, t = ts, key = secret) => provider.verifyAndParseWebhook({ rawBody: body, headers: headers({ "x-timestamp": t, "x-signature": sig }), secret: key, now });
		expect(bad("deadbeef")).toEqual({ ok: false, reason: "bad_signature" });
		expect(bad(sign(raw), raw.replace("preço", "preco"))).toEqual({ ok: false, reason: "bad_signature" });
		expect(bad(sign(raw, ts, "outro"))).toEqual({ ok: false, reason: "bad_signature" });
		const old = String(Math.floor(now.getTime() / 1000) - 3600);
		expect(bad(sign(raw, old), raw, old)).toEqual({ ok: false, reason: "stale" });
		expect(provider.verifyAndParseWebhook({ rawBody: raw, headers: headers({}), secret, now })).toEqual({ ok: false, reason: "bad_signature" });
	});

	it("eventos que não são e-mail recebido são confirmados e ignorados", () => {
		const raw = JSON.stringify({ event: "inbox.suspended", event_id: "e2", inbox_id: "inb_1" });
		expect(provider.verifyAndParseWebhook({ rawBody: raw, headers: headers({ "x-timestamp": ts, "x-signature": sign(raw) }), secret, now })).toEqual({ ok: true, event: null });
	});

	it("payload sem mensagem é inválido", () => {
		const raw = JSON.stringify({ event: "message.received", event_id: "e3", message: {} });
		expect(provider.verifyAndParseWebhook({ rawBody: raw, headers: headers({ "x-timestamp": ts, "x-signature": sign(raw) }), secret, now })).toEqual({ ok: false, reason: "bad_payload" });
	});
});

describe("openmail: domínios próprios", () => {
	const DOMAIN = { id: "dom_1", domain: "SuaEmpresa.com.br", status: "pending", records: [{ type: "MX", name: "suaempresa.com.br", value: "inbound-smtp.example", priority: 10, purpose: "mx", status: "missing" }, { type: "TXT", name: "omail._domainkey.suaempresa.com.br", value: "v=DKIM1; k=rsa; p=abc", priority: null, purpose: "dkim", status: "valid" }] };

	it("adiciona o domínio e devolve os registros DNS normalizados", async () => {
		const { fetchFn, calls } = fakeFetch([{ status: 201, body: DOMAIN }]);
		const result = await createOpenMailProvider({ fetchFn }).domains!.add(KEY, "suaempresa.com.br");
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.url).toBe("https://api.openmail.sh/v1/domains");
		expect(JSON.parse(calls[0]!.body!)).toEqual({ domain: "suaempresa.com.br" });
		expect(result).toMatchObject({ id: "dom_1", domain: "suaempresa.com.br", status: "pending" });
		expect(result.records[0]).toEqual({ type: "MX", name: "suaempresa.com.br", value: "inbound-smtp.example", priority: 10, valid: false });
		expect(result.records[1]).toMatchObject({ type: "TXT", priority: null, valid: true });
	});

	it("lista (data[]) e verifica: re-check seguido de GET com o estado atual", async () => {
		const list = fakeFetch([{ body: { data: [DOMAIN], total: 1 } }]);
		expect(await createOpenMailProvider({ fetchFn: list.fetchFn }).domains!.list(KEY)).toHaveLength(1);
		expect(list.calls[0]!.url).toContain("/v1/domains?");
		const verify = fakeFetch([{ status: 202, body: {} }, { body: { ...DOMAIN, status: "verified" } }]);
		const result = await createOpenMailProvider({ fetchFn: verify.fetchFn }).domains!.verify(KEY, "dom_1");
		expect(verify.calls.map((c) => `${c.method} ${c.url.replace("https://api.openmail.sh", "")}`)).toEqual(["POST /v1/domains/dom_1/verify", "GET /v1/domains/dom_1"]);
		expect(result.status).toBe("verified");
	});

	it("remove com DELETE", async () => {
		const { fetchFn, calls } = fakeFetch([{ status: 200, body: {} }]);
		await createOpenMailProvider({ fetchFn }).domains!.remove(KEY, "dom_1");
		expect(calls[0]).toMatchObject({ method: "DELETE", url: "https://api.openmail.sh/v1/domains/dom_1" });
	});

	it("erros do plano e de domínio viram códigos e mensagens fixas (sem o corpo do upstream)", async () => {
		const plan = createOpenMailProvider({ fetchFn: fakeFetch([{ status: 403, body: { error: "plan_limit", message: "Custom domains require Pro om_FAKE" } }]).fetchFn });
		const error = await plan.domains!.add(KEY, "a.com").catch((e: unknown) => e as EmailProviderError);
		expect(error).toMatchObject({ code: "plan_required", message: "Domínio próprio exige um plano pago do OpenMail." });
		expect(String((error as Error).message)).not.toContain("om_FAKE");
		const dup = createOpenMailProvider({ fetchFn: fakeFetch([{ status: 409, body: { error: "domain_exists" } }]).fetchFn });
		await expect(dup.domains!.add(KEY, "a.com")).rejects.toMatchObject({ code: "domain_exists" });
		const inUse = createOpenMailProvider({ fetchFn: fakeFetch([{ status: 422, body: { error: "domain_has_inboxes" } }]).fetchFn });
		await expect(inUse.domains!.remove(KEY, "d")).rejects.toMatchObject({ code: "domain_in_use" });
		const forbidden = createOpenMailProvider({ fetchFn: fakeFetch([{ status: 403, body: { error: "forbidden" } }]).fetchFn });
		await expect(forbidden.domains!.list(KEY)).rejects.toMatchObject({ code: "auth_failed" });
	});

	it("cria a caixa num domínio verificado (campo domain no POST /v1/inboxes)", async () => {
		const { fetchFn, calls } = fakeFetch([{ status: 201, body: { id: "inb_2", address: "atendimento@suaempresa.com.br", webhookSecret: "w" } }]);
		const inbox = await createOpenMailProvider({ fetchFn }).createInbox(KEY, { displayName: "Bot", nameHint: "Bot", webhookUrl: "https://x/y", mailboxName: "atendimento", domain: "suaempresa.com.br" });
		expect(JSON.parse(calls[0]!.body!)).toMatchObject({ mailboxName: "atendimento", domain: "suaempresa.com.br" });
		expect(inbox.address).toBe("atendimento@suaempresa.com.br");
		const plain = fakeFetch([{ status: 201, body: { id: "i", address: "a-bcd@openmail.sh" } }]);
		await createOpenMailProvider({ fetchFn: plain.fetchFn }).createInbox(KEY, { displayName: "Bot", nameHint: "Bot", webhookUrl: "https://x/y" });
		expect(JSON.parse(plain.calls[0]!.body!)).not.toHaveProperty("domain");
	});
});
