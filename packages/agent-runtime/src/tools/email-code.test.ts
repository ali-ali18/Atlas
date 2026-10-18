import { describe, expect, it, vi } from "vitest";
import type { McpRuntime } from "../mcp/runtime.js";
import { extractLoginCode, fetchLoginEmailCode, findEmailSource, parseEmailResult, senderAllowed, type EmailMessage, type EmailSource } from "./email-code.js";

const NOW = Date.parse("2026-10-15T15:00:00Z");
const fresh = (overrides: Partial<EmailMessage>): EmailMessage => ({ from: "ChatGPT <noreply@tm.openai.com>", subject: "Your ChatGPT code is 482913", body: "", at: NOW - 30_000, ...overrides });
const sourceOf = (messages: EmailMessage[]): EmailSource => ({ name: "Gmail", search: async () => messages });
const run = (messages: EmailMessage[], extra: Partial<Parameters<typeof fetchLoginEmailCode>[0]> = {}) =>
	fetchLoginEmailCode({ source: sourceOf(messages), siteHost: "chatgpt.com", startedAtMs: NOW - 10_000, now: () => NOW, sleep: async () => undefined, timeoutMs: 0, ...extra });

describe("extração do código", () => {
	it("acha 4 a 8 dígitos perto de code/código/verification", () => {
		expect(extractLoginCode("Your ChatGPT code is 482913")).toBe("482913");
		expect(extractLoginCode("Seu código de verificação: 1234")).toBe("1234");
		expect(extractLoginCode("Enter this verification code to continue: 99887766")).toBe("99887766");
		expect(extractLoginCode("482913 is your verification code")).toBe("482913");
		expect(extractLoginCode("Código: A1B2C3")).toBe("A1B2C3");
		expect(extractLoginCode("Pedido 2026101500 enviado")).toBeNull();
	});
});

describe("remetente", () => {
	it("mesmo domínio, envio conhecido ou nome do site no domínio; outros não", () => {
		expect(senderAllowed("ChatGPT <noreply@tm.openai.com>", "chatgpt.com")).toBe(true);
		expect(senderAllowed("noreply@openai.com", "chatgpt.com")).toBe(true);
		expect(senderAllowed("x@mail.chatgpt.com", "chatgpt.com")).toBe(true);
		expect(senderAllowed("x@notifications.bling.com.br", "www.bling.com.br")).toBe(true);
		expect(senderAllowed("x@chatgpt-security-alert.example", "chatgpt.com")).toBe(true);
		expect(senderAllowed("phisher@evil.example", "chatgpt.com")).toBe(false);
		expect(senderAllowed("Fulano <fulano@gmail.com>", "chatgpt.com")).toBe(false);
	});
});

describe("busca do código", () => {
	it("código achado no assunto de mensagem recente do site", async () => {
		expect(await run([fresh({})])).toBe("482913");
	});

	it("e-mail de outro remetente é ignorado", async () => {
		expect(await run([fresh({ from: "Golpe <alerta@evil.example>", subject: "Your code is 111111" })])).toBeNull();
	});

	it("e-mail antigo (antes do login ou fora da janela) é ignorado", async () => {
		expect(await run([fresh({ at: NOW - 3_600_000 })])).toBeNull();
		expect(await run([fresh({ at: NOW - 120_000 })], { startedAtMs: NOW - 10_000 })).toBeNull();
	});

	it("espera e repete: o e-mail chega na 3ª tentativa", async () => {
		let calls = 0;
		let clock = NOW;
		const source: EmailSource = { name: "Gmail", search: async () => (++calls < 3 ? [] : [fresh({ at: clock - 1000 })]) };
		const code = await fetchLoginEmailCode({ source, siteHost: "chatgpt.com", startedAtMs: NOW - 10_000, now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 60_000, intervalMs: 5_000 });
		expect(code).toBe("482913");
		expect(calls).toBe(3);
	});

	it("conector com erro não derruba: devolve null no prazo", async () => {
		const source: EmailSource = { name: "Gmail", search: async () => { throw new Error("401"); } };
		expect(await fetchLoginEmailCode({ source, siteHost: "chatgpt.com", startedAtMs: NOW, now: () => NOW, sleep: async () => undefined, timeoutMs: 0 })).toBeNull();
	});
});

const GMAIL_TEXT = [
	"id: m1\nthreadId: t1\nde: ChatGPT <noreply@tm.openai.com>\nassunto: Your ChatGPT code is 482913\ndata: Thu, 15 Oct 2026 14:59:30 +0000\nresumo: Enter this code",
	"id: m2\nthreadId: t2\nde: Alguem <a@b.com>\nassunto: oi\ndata: Thu, 15 Oct 2026 10:00:00 +0000\nresumo: nada",
].join("\n\n");

describe("conector de e-mail", () => {
	it("lê o texto do Gmail nativo e o JSON de conectores Composio", () => {
		const parsed = parseEmailResult(GMAIL_TEXT);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({ id: "m1", from: "ChatGPT <noreply@tm.openai.com>", subject: "Your ChatGPT code is 482913" });
		expect(parsed[0]!.at).toBe(Date.parse("2026-10-15T14:59:30Z"));
		const composio = parseEmailResult(JSON.stringify({ data: { messages: [{ messageId: "x", sender: "OpenAI <a@openai.com>", subject: "Code", messageText: "code 123456", messageTimestamp: "2026-10-15T14:59:00Z" }] } }));
		expect(composio[0]).toMatchObject({ id: "x", from: "OpenAI <a@openai.com>" });
	});

	it("descobre o Gmail pelas ferramentas de leitura e só chama leitura, com remetente e janela na consulta", async () => {
		const call = vi.fn(async () => ({ ok: true, text: GMAIL_TEXT, truncated: false }));
		const entry = (toolName: string, readOnly: boolean) => ({ connectionId: "c1", connectionName: "Gmail", toolName, readOnly, actionClass: "read" as const, autonomyMeta: { actionClass: "read" as const, tool: toolName }, requiresConfirmation: false });
		const params = { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } } };
		const mcp = {
			toolset: {
				tools: [], omitted: [], index: [], connectorNames: ["Gmail"], deferred: false,
				entries: new Map([["mcp__gmail__search_messages", entry("search_messages", true)], ["mcp__gmail__create_draft", entry("create_draft", false)]]),
				available: new Map([["mcp__gmail__search_messages", { type: "function", function: { name: "mcp__gmail__search_messages", description: "", parameters: params } }]]),
			},
			call,
		} as unknown as McpRuntime;
		const source = findEmailSource(mcp)!;
		expect(source.name).toBe("Gmail");
		const messages = await source.search({ domains: ["chatgpt.com", "openai.com"], sinceMs: NOW });
		expect(messages).toHaveLength(2);
		expect(call).toHaveBeenCalledTimes(1);
		const [name, args] = call.mock.calls[0] as unknown as [string, Record<string, string>];
		expect(name).toBe("mcp__gmail__search_messages");
		expect(args.query).toContain("from:(chatgpt.com OR openai.com)");
		expect(args.query).toContain(`after:${Math.floor(NOW / 1000)}`);
		expect(findEmailSource(null)).toBeNull();
	});
});
