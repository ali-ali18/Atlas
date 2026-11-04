import { SandboxOperationTimeoutError } from "@workspace/sandbox";
import type { ComputerToolContext } from "../computer-refs.js";
import type { ToolContext } from "../registry/types.js";

/** Contexto que as funções do navegador (v1/v2) já usam, a partir do contexto de tool do run. */
export function computerCtx(ctx: ToolContext): ComputerToolContext {
	return { manager: ctx.manager, getSessionId: ctx.getSessionId, runId: ctx.runId, loginAsked: ctx.loginAsked ?? new Set<string>(), canSeeImages: ctx.canSeeImages };
}

/** Ref do snapshot: `a12` (árvore), `e12` (DOM) ou `f1a12` (dentro de um frame). */
export const REF_PATTERN = /^(?:f\d{1,3})?[ea]\d{1,5}$/;

/** A chamada à VM estourou o tempo: o efeito pode ter acontecido (o servidor não desfaz). */
export function isTimeoutError(error: unknown): boolean {
	if (error instanceof SandboxOperationTimeoutError) return true;
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	return name === "TimeoutError" || /\bTimeout \d+ms exceeded\b/.test(message);
}

export const MAY_HAVE_HAPPENED = "the action may have happened; inspect the page (browser_snapshot) before repeating it";

/**
 * `tab` (número de `browser_tabs list`, a partir de 1): se não é a aba ativa, troca antes de agir. Sem `tab`, a aba ativa.
 * Aba que não existe vira erro com a lista (nada é feito na aba errada).
 */
export async function ensureTab(ctx: ToolContext, tab: number | undefined): Promise<void> {
	if (tab === undefined) return;
	const sessionId = await ctx.getSessionId();
	const listed = await ctx.manager.execBrowserTabs(sessionId, { action: "list" });
	if (listed.action !== "list") return;
	const target = listed.tabs.find((item) => item.index === tab);
	if (!target) throw new Error(`Tab ${tab} does not exist. Open tabs: ${listed.tabs.map((item) => item.index).join(", ") || "none"}. Use browser_tabs list.`);
	if (!target.active) await ctx.manager.execBrowserTabs(sessionId, { action: "switch", index: tab });
}
