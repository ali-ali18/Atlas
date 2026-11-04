import { browserNavigateTool } from "../browser-v3/navigate.js";
import { getResolvedDefinedTool, getToolRegistration } from "./index.js";
import type { ToolEffect, ToolMetaFields, ToolRegistration } from "./types.js";

/**
 * Metadado por tool (desenho do harness v3, seção 3/7): `effect`, `poll`, `endsTurn`, `needsHuman`, `ownCard`. Cada
 * tool nativa declara o dela com `defineTool`/`defineRawTool`, ao lado da definição e do handler (família em
 * `handlers/*.ts`); aqui só se lê (`getToolMeta`), do registro ou dos resolvedores (sessão de código). O teste
 * `tool-meta.test.ts` falha se uma tool do registro, do catálogo ou da sessão de código ficar sem efeito, e
 * `define-tool.test.ts` se alguma não vier de `defineTool`.
 *
 * Decisões que não são óbvias (valem para os `effect` declarados nas famílias):
 * - Navegador e VM são do próprio bot (`write_internal`): clique, digitação e shell não saem da VM por si.
 *   O que toca segredo é `login_fill`/`secret_request` (`credential`).
 * - `propose_*` só gera cartão de aprovação: `write_internal` (a escrita real acontece depois, na decisão).
 * - `effect` é o pior caso; `effectForArgs` o refina por chamada (`resolveToolEffect`): `api_call` só lê, `sandbox_download`
 *   só é `credential` com a sessão do navegador. Tool de conector MCP é decidida por `mcpToolEffect`.
 * - `propose_routine`/`routine_group` criam webhook no GitHub do dono (`ensureGithubRepoHook`): `write_external`.
 *   `decide_bot_pending` aprova ação de outro bot: `write_external` (igual a `NATIVE_WRITE_TOOLS` do pre-tool).
 * - `endsTurn` = encerra o turno quando devolve cartão pendente (computer-use.ts, `stopFor*`).
 * - `ownCard` = a tool já mostra o cartão de aprovação dela (e-mail, propostas, imagem, PR, segredo, login, sessão de
 *   código): o motor v3 não põe o cartão genérico em cima.
 * - `needsHuman` = muda as próprias permissões (hoje com o portão `humanTurn`) ou só existe com humano hoje: questionário, `sandbox_release`,
 *   skills, `delegate*` e `propose_bot` (espelha os filtros por origem do catálogo v1/v2).
 */

/** Efeito desta chamada: `effectForArgs` quando existe, senão o `effect` estático (pior caso). MCP/desconhecido: `undefined`. */
export function resolveToolEffect(name: string, args: Record<string, unknown>): ToolEffect | undefined {
	const meta = getToolMeta(name);
	return meta ? (meta.effectForArgs?.(args) ?? meta.effect) : undefined;
}

/** Só o metadado do registro (sem handler, grupo nem definição). */
function metaOf(registration: ToolRegistration): ToolMetaFields | undefined {
	if (!registration.effect) return undefined;
	const { effect, poll, endsTurn, needsHuman, ownCard, effectForArgs, catalogEffect } = registration;
	return {
		effect,
		...(poll ? { poll } : {}),
		...(endsTurn ? { endsTurn } : {}),
		...(needsHuman ? { needsHuman } : {}),
		...(ownCard ? { ownCard } : {}),
		...(catalogEffect ? { catalogEffect } : {}),
		...(effectForArgs ? { effectForArgs } : {}),
	};
}

/**
 * Tools que só existem no motor v3 (navegador novo, PR6): fora do registro global, então o catálogo e o retrato do
 * v1/v2 não mudam. As outras 3 do navegador v3 repetem nomes do registro (mesmo efeito) e rodam por `V3Run.toolHandlers`.
 */
const V3_ONLY_META: ReadonlyMap<string, ToolMetaFields> = new Map([[browserNavigateTool.name, browserNavigateTool.meta]]);

/** Tool declarada com `defineTool`/`defineRawTool` (o metadado vem dela, não da tabela). */
export function isDefinedTool(name: string): boolean {
	return getToolRegistration(name)?.defined === true || getResolvedDefinedTool(name) !== undefined || V3_ONLY_META.has(name);
}

/**
 * Metadado da tool de nome fixo: vem do registro (`defineTool`) ou do resolvedor da sessão de código.
 * `undefined` para MCP e nome desconhecido (ver `mcpToolEffect`).
 */
export function getToolMeta(name: string): ToolMetaFields | undefined {
	const registered = getToolRegistration(name);
	return (registered && metaOf(registered)) ?? getResolvedDefinedTool(name)?.meta ?? V3_ONLY_META.get(name);
}
/**
 * Efeito de uma tool de conector MCP. Deriva da classificação que já existe
 * (`isReadOnlyMcpTool` em `@workspace/shared`, anotações do servidor + marcas do usuário) em vez de criar outra: leitura = `read`; o resto = `write_external` (escrita em terceiro).
 */
export function mcpToolEffect(isReadOnly: boolean): ToolEffect {
	return isReadOnly ? "read" : "write_external";
}
