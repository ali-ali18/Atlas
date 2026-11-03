import { getToolMeta, mcpToolEffect, resolveToolEffect } from "../tools/registry/tool-meta.js";
import type { PolicyTool } from "./decide.js";

/**
 * Monta o `PolicyTool` de uma tool nativa. Com `args` (execução) usa o efeito refinado da chamada; sem eles
 * (montagem do catálogo) usa o pior caso. Tool sem metadado (nome desconhecido) devolve `undefined`: quem chama decide o que fazer.
 */
export function nativePolicyTool(name: string, args?: Record<string, unknown>): PolicyTool | undefined {
	const meta = getToolMeta(name);
	if (!meta) return undefined;
	const effect = args ? (resolveToolEffect(name, args) ?? meta.effect) : meta.effect;
	return { name, effect, ...(meta.needsHuman ? { needsHuman: true } : {}) };
}

/** Tool de conector MCP: leitura = `read`; o resto = `write_external` (`mcpToolEffect`). */
export function mcpPolicyTool(name: string, input: { connectionId: string; readOnly: boolean }): PolicyTool {
	return { name, effect: mcpToolEffect(input.readOnly), connectorId: input.connectionId };
}
