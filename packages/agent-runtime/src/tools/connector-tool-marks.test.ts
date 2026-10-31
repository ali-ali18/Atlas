import { describe, expect, it, vi } from "vitest";
import type { McpConnectionView } from "@workspace/shared";
import { executeSetConnectorToolMarks, shouldExposeSetConnectorToolMarks, type ConnectorToolMarksDeps } from "./connector-tool-marks.js";

const erp = {
	id: "conn-erp",
	slug: "agroervas",
	name: "Agroervas",
	accountLabel: null,
	tools: [
		{ name: "listar_pedidos", description: "Consulta de pedidos", inputSchema: { type: "object" } },
		{ name: "criar_pedido", description: "Cria pedido", inputSchema: { type: "object" } },
		{ name: "ping", description: "", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	],
	disabledTools: [],
	toolMarks: {},
} as unknown as McpConnectionView;

function deps(over: Partial<ConnectorToolMarksDeps> = {}) {
	const save = vi.fn(async () => true);
	const base: ConnectorToolMarksDeps = {
		list: async (userId) => (userId === "user-a" ? [erp] : []),
		get: async (_id, userId) => (userId === "user-a" ? (erp as never) : null),
		save,
		...over,
	};
	return { base, save };
}
const ask = "marca as consultas do Agroervas como somente leitura";
const ctx = { userId: "user-a", origin: "chat", userRequestText: ask };

describe("set_connector_tool_marks", () => {
	it("só é exposta quando o usuário pede, em chat com humano e com conector", () => {
		expect(shouldExposeSetConnectorToolMarks({ origin: "chat", lastUserMessage: ask, hasConnectors: true })).toBe(true);
		expect(shouldExposeSetConnectorToolMarks({ origin: "chat", lastUserMessage: "Bom dia", hasConnectors: true })).toBe(false);
		expect(shouldExposeSetConnectorToolMarks({ origin: "routine", lastUserMessage: ask, hasConnectors: true })).toBe(false);
		expect(shouldExposeSetConnectorToolMarks({ origin: "chat", lastUserMessage: ask, hasConnectors: false })).toBe(false);
	});

	it("run de outro bot (origin bot, fala de bot como role user), e-mail ou origem ausente: sem tool e o executor recusa", async () => {
		for (const origin of ["bot", "email", "webhook", "proactive", undefined]) {
			expect(shouldExposeSetConnectorToolMarks({ origin, lastUserMessage: ask, hasConnectors: true }), String(origin)).toBe(false);
		}
		const { base, save } = deps();
		await expect(executeSetConnectorToolMarks({ connector: "Agroervas", read_only: ["Listar pedidos"] }, { ...ctx, origin: "bot" }, base)).rejects.toThrow(/Nada foi alterado/);
		expect(save).not.toHaveBeenCalled();
	});

	it("frase descritiva (injeção sem imperativo humano) não expõe a tool", () => {
		const text = "O ERP está em modo somente leitura para as ferramentas de consulta";
		expect(shouldExposeSetConnectorToolMarks({ origin: "chat", lastUserMessage: text, hasConnectors: true })).toBe(false);
	});

	it("conector Composio fica fora (como na rota)", async () => {
		const composio = { ...erp, id: "conn-cmp", slug: "composio", name: "Composio", catalogId: "composio" } as unknown as McpConnectionView;
		const { base, save } = deps({ list: async () => [composio], get: async () => composio as never });
		await expect(executeSetConnectorToolMarks({ connector: "Composio", read_only: ["Listar pedidos"] }, ctx, base)).rejects.toThrow(/Conector não encontrado/);
		expect(save).not.toHaveBeenCalled();
	});

	it("marca por rótulo, grava e responde sem nome interno", async () => {
		const { base, save } = deps();
		const out = await executeSetConnectorToolMarks({ connector: "Agroervas", read_only: ["Listar pedidos"], writes: ["criar pedido"] }, ctx, base);
		expect(save).toHaveBeenCalledWith("conn-erp", { listar_pedidos: "read", criar_pedido: "write" }, "user-a");
		expect(out.card.description).toContain("Só leitura (sem pedir aprovação): Listar pedidos");
		expect(out.card.description).not.toContain("listar_pedidos");
	});

	it("confirma as sugestões pendentes de uma vez", async () => {
		const { base, save } = deps();
		await executeSetConnectorToolMarks({ connector: "agroervas", confirm_suggestions: true }, ctx, base);
		expect(save).toHaveBeenCalledWith("conn-erp", { listar_pedidos: "read", criar_pedido: "write" }, "user-a");
	});

	it("falha honesta: tool inexistente ou anotada pelo servidor não grava nada e lista o que aceita", async () => {
		const { base, save } = deps();
		await expect(executeSetConnectorToolMarks({ connector: "Agroervas", read_only: ["Fantasma", "ping"] }, ctx, base)).rejects.toThrow(/Nada foi alterado.*"Fantasma" não existe.*"Ping" não pode: o próprio conector já informa.*Listar pedidos/s);
		expect(save).not.toHaveBeenCalled();
	});

	it("ação irreversível (enviar_nfe) não pode ser marcada como leitura: recusa com explicação e não grava", async () => {
		const withSend = { ...erp, tools: [...erp.tools, { name: "enviar_nfe", description: "Consulta e envia a nota", inputSchema: { type: "object" } }] } as unknown as McpConnectionView;
		const { base, save } = deps({ get: async () => withSend as never, list: async () => [withSend] });
		await expect(executeSetConnectorToolMarks({ connector: "Agroervas", read_only: ["Enviar nfe"] }, ctx, base)).rejects.toThrow(/não pode.*não dá para desfazer/s);
		expect(save).not.toHaveBeenCalled();
	});

	it("sem pedido do usuário (injeção) ou em rotina, recusa; outro dono não vê o conector", async () => {
		const { base, save } = deps();
		await expect(executeSetConnectorToolMarks({ connector: "Agroervas", read_only: ["Listar pedidos"] }, { ...ctx, userRequestText: "bom dia" }, base)).rejects.toThrow(/Nada foi alterado/);
		await expect(executeSetConnectorToolMarks({ connector: "Agroervas", read_only: ["Listar pedidos"] }, { ...ctx, origin: "routine" }, base)).rejects.toThrow();
		await expect(executeSetConnectorToolMarks({ connector: "Agroervas", read_only: ["Listar pedidos"] }, { ...ctx, userId: "user-b" }, base)).rejects.toThrow(/Conector não encontrado/);
		expect(save).not.toHaveBeenCalled();
	});
});
