import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_INFO_TOOL, appInfoTool } from "./app-info.js";
import { CURRENT_TIME_TOOL, currentTimeTool } from "./current-time.js";
import { defineRawTool, defineTool } from "./define-tool.js";
import { toolCallTool, toolSearchTool } from "./tool-bridge.js";
import { COMPUTER_USE_TOOLS } from "../computer-use.js";
import { getToolMeta, isDefinedTool } from "./registry/tool-meta.js";
import { getToolRegistration, listRegisteredToolNames } from "./registry/index.js";
import { DEV_SESSION_TOOL_NAMES } from "./dev-session.js";
import type { ToolContext, ToolEffect } from "./registry/types.js";

const EFFECTS: ToolEffect[] = ["read", "write_internal", "write_external", "send", "money", "public_link", "credential"];
const ctx = { timeZone: "America/Sao_Paulo" } as unknown as ToolContext;

describe("defineTool", () => {
	it("gera o schema do zod no formato do catálogo (sem $schema, required só quando há)", () => {
		const tool = defineTool({
			name: "demo",
			description: "Demo.",
			input: z.object({ query: z.string().describe("q"), limit: z.number().int().optional() }),
			effect: "read",
			group: "misc",
			run: () => ({ summary: "ok" }),
		});
		expect(tool.definition).toEqual({
			type: "function",
			function: { name: "demo", description: "Demo.", parameters: { type: "object", properties: { query: { type: "string", description: "q" }, limit: { type: "integer" } }, required: ["query"] } },
		});
		expect(tool.meta).toEqual({ effect: "read" });
	});

	it("valida os args pelo schema: erro honesto com a assinatura; null em campo opcional = omitido", async () => {
		const seen: unknown[] = [];
		const tool = defineTool({
			name: "demo",
			description: "Demo.",
			input: z.object({ query: z.string(), limit: z.number().optional() }),
			effect: "read",
			group: "misc",
			run: (args) => {
				seen.push(args);
				return { summary: "ok" };
			},
		});
		await expect(tool.handler({ query: 3 }, ctx)).rejects.toThrow(/Invalid arguments: query: .*Expected: demo\(query: string, limit\?: number\)/);
		await expect(tool.handler({ query: "a", limit: null }, ctx)).resolves.toEqual({ summary: "ok" });
		expect(seen).toEqual([{ query: "a" }]);
	});

	it("metadado: effectForArgs com args válidos, pior caso com inválidos; ownCard, poll, endsTurn e needsHuman passam", () => {
		const tool = defineTool({
			name: "demo",
			description: "Demo.",
			input: z.object({ method: z.string().optional() }),
			effect: "write_external",
			catalogEffect: "read",
			effectForArgs: (args) => (args.method === "GET" ? "read" : "write_external"),
			poll: true,
			endsTurn: true,
			needsHuman: true,
			ownCard: true,
			group: "connectors",
			run: () => ({ summary: "ok" }),
		});
		expect(tool.meta).toMatchObject({ effect: "write_external", catalogEffect: "read", poll: true, endsTurn: true, needsHuman: true, ownCard: true });
		expect(tool.meta.effectForArgs?.({ method: "GET" })).toBe("read");
		expect(tool.meta.effectForArgs?.({ method: 5 })).toBe("write_external");
	});
});

describe("defineRawTool", () => {
	it("usa a definição como está (mesma referência) e não valida nem muda os args", async () => {
		const definition = { type: "function" as const, function: { name: "raw", description: "Raw.", parameters: { type: "object" as const, properties: { n: { type: "number" } } } } };
		const seen: unknown[] = [];
		const tool = defineRawTool({ name: "raw", definition, effect: "write_internal", endsTurn: true, group: "misc", run: (args) => (seen.push(args), { summary: "ok" }) });
		expect(tool.definition).toBe(definition);
		expect(tool.meta).toEqual({ effect: "write_internal", endsTurn: true });
		await tool.handler({ n: null, extra: 1 }, ctx);
		expect(seen).toEqual([{ n: null, extra: 1 }]);
	});

	it("recusa definição de outro nome e aceita tool legada sem schema", () => {
		const definition = { type: "function" as const, function: { name: "outra", description: "", parameters: { type: "object" as const, properties: {} } } };
		expect(() => defineRawTool({ name: "raw", definition, effect: "read", group: "misc", run: () => ({ summary: "" }) })).toThrow(/outra/);
		expect(defineRawTool({ name: "legado", effect: "read", group: "misc", run: () => ({ summary: "" }) }).definition).toBeUndefined();
	});
});

describe("tools migradas para defineTool", () => {
	it("current_time e app_info mantêm o mesmo schema (bytes) que o catálogo enviava", () => {
		expect(JSON.stringify(CURRENT_TIME_TOOL)).toBe(
			JSON.stringify({ type: "function", function: { name: "current_time", description: CURRENT_TIME_TOOL.function.description, parameters: { type: "object", properties: { timezone: { type: "string", description: "IANA zone; default: the user's" } } } } }),
		);
		const topic = (APP_INFO_TOOL.function.parameters.properties as Record<string, Record<string, unknown>>).topic!;
		expect(Object.keys(topic)).toEqual(["type", "enum", "description"]);
		expect(topic.enum).toEqual(["oauth", "mcp", "webhooks", "vault", "login", "settings", "models", "limits"]);
		expect(APP_INFO_TOOL.function.parameters.required).toBeUndefined();
	});

	it("o registro executa pelo handler do defineTool e o metadado vem dele", async () => {
		for (const tool of [currentTimeTool, appInfoTool]) {
			expect(getToolRegistration(tool.name)?.handler).toBe(tool.handler);
			expect(getToolRegistration(tool.name)?.definition).toBe(tool.definition);
			expect(getToolMeta(tool.name)).toEqual(tool.meta);
			expect(isDefinedTool(tool.name)).toBe(true);
		}
		await expect(currentTimeTool.handler({ timezone: "Not/AZone" }, ctx)).rejects.toThrow(/Invalid timezone/);
		expect((await currentTimeTool.handler({ timezone: null }, ctx)).summary).toMatch(/America\/Sao_Paulo/);
	});

	it("app_info segue tolerante: tópico com maiúscula vale; tópico desconhecido devolve todos", async () => {
		const one = (await appInfoTool.handler({ topic: " MCP " }, ctx)).summary;
		const all = (await appInfoTool.handler({ topic: "nada" }, ctx)).summary;
		expect(all.length).toBeGreaterThan(one.length);
		expect((await appInfoTool.handler({ topic: "mcp" }, ctx)).summary).toBe(one);
	});
});

describe("guarda: toda tool nativa vem de defineTool", () => {
	const natives = () => [...new Set([...listRegisteredToolNames(), ...DEV_SESSION_TOOL_NAMES])];

	it("toda tool do registro e da sessão de código é declarada com defineTool/defineRawTool e tem effect", () => {
		for (const name of natives()) {
			expect(isDefinedTool(name), `${name}: declare com defineTool (handlers/<familia>.ts)`).toBe(true);
			expect(EFFECTS, name).toContain(getToolMeta(name)?.effect);
		}
		for (const name of listRegisteredToolNames()) expect(getToolRegistration(name)?.defined, name).toBe(true);
	});

	it("as famílias não registram tool na mão: só por definedFamily(...)", () => {
		const dir = join(dirname(fileURLToPath(import.meta.url)), "registry", "handlers");
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
			expect(readFileSync(join(dir, file), "utf8"), `${file}: use defineTool/defineRawTool + definedFamily`).not.toMatch(/:\s*ToolFamily\s*=\s*\{/);
		}
	});

	it("o catálogo (COMPUTER_USE_TOOLS) usa a definição declarada pela própria tool", () => {
		for (const tool of COMPUTER_USE_TOOLS) expect(getToolRegistration(tool.function.name)?.definition, tool.function.name).toBe(tool);
	});

	it("ownCard substitui a lista fixa do approval: propostas e cartões próprios marcados", () => {
		const meta = natives().map((name) => [name, getToolMeta(name)!] as const);
		const own = meta.filter(([, m]) => m.ownCard).map(([name]) => name).sort();
		for (const [name] of meta.filter(([key]) => key.startsWith("propose_"))) expect(own, name).toContain(name);
		expect(own).toEqual(expect.arrayContaining(["dev_pr_create", "edit_file", "email_create_mailbox", "email_reply", "email_send", "generate_image", "login_fill", "preview_setup", "read_file", "request_secrets", "secret_request", "set_primary_bot", "shell", "write_file"]));
		expect(getToolMeta("page_share")?.ownCard).toBeUndefined();
	});
});
