import { getToolMeta, mcpToolEffect, resolveToolEffect } from "../tools/registry/tool-meta.js";
import type { ToolMetaFields } from "../tools/registry/types.js";
import type { PolicyTool } from "./decide.js";

/**
 * Monta o `PolicyTool` de uma tool nativa. Com `args` (execução) usa o efeito refinado da chamada; sem eles
 * (montagem do catálogo) usa o efeito mais permissivo (`catalogEffect`, senão `effect`). Tool sem metadado (nome desconhecido) devolve `undefined`: quem chama decide o que fazer.
 */
export function nativePolicyTool(name: string, args?: Record<string, unknown>, overrides?: ReadonlyMap<string, ToolMetaFields>): PolicyTool | undefined {
	// `overrides`: metadado que vale no lugar do registro global (as tools do navegador do motor v3 repetem nomes do v1/v2).
	const own = overrides?.get(name);
	const meta = own ?? getToolMeta(name);
	if (!meta) return undefined;
	// Catálogo (sem args): o efeito mais permissivo possível, para a tool aparecer; a decisão real vem na execução, com os args.
	const effect = args ? ((own ? (own.effectForArgs?.(args) ?? own.effect) : resolveToolEffect(name, args)) ?? meta.effect) : (meta.catalogEffect ?? meta.effect);
	return { name, effect, ...(meta.needsHuman ? { needsHuman: true } : {}) };
}

/** Tool de conector MCP: leitura = `read`; o resto = `write_external` (`mcpToolEffect`). */
export function mcpPolicyTool(name: string, input: { connectionId: string; readOnly: boolean }): PolicyTool {
	return { name, effect: mcpToolEffect(input.readOnly), connectorId: input.connectionId };
}
