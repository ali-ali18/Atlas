import type { ControlActionEffect } from "@workspace/sandbox";
import { captureModelScreenshot } from "./screenshot-model.js";
import type { ToolContext, ToolResult } from "./registry/types.js";

// Visão como rede de segurança da leitura: quando o texto não traz o que o bot
// acabou de acionar (painel lateral, resposta de chat, overlay), o resultado
// da tool já leva um screenshot da viewport. Evita uma volta inteira de "li,
// não achei, vou tirar um print". No máximo um por passo (o motor controla),
// só com modelo que enxerga imagem, e nunca falha a tool que o chamou.

export type VisionReason = "capped" | "silent-click";

const NOTES: Record<VisionReason, string> = {
	capped:
		"[Vision fallback: the read was cut at its cap, so a screenshot of the screen is attached. If what you triggered or expect (a side panel, chat answer, overlay) is not in the text above, read it from the screenshot before asking the user. A screenshot with marks=true shows ref numbers to click by (12 = e12).]",
	"silent-click":
		"[Vision fallback: the click reported no new text, so a screenshot of the screen is attached. If the panel or answer you expected is visible there, read it from the image; if it is still loading, call browser_wait with for=text_stable. A screenshot with marks=true shows ref numbers to click by (12 = e12).]",
};

/** Clique que não navegou nem trouxe texto, diálogo ou estado novo: o efeito pode estar só na tela. */
export function isSilentClick(effect: Pick<ControlActionEffect, "navigated" | "changes">): boolean {
	if (effect.navigated) return false;
	const changes = effect.changes;
	if (!changes) return true;
	if (changes.reloaded || changes.added) return false;
	if (changes.states?.length || changes.dialogsOpened?.length || changes.tree?.length) return false;
	return true;
}

type Outcome = { summary: string; vision?: VisionReason } & Partial<ToolResult>;

/** Anexa o screenshot quando o resultado pede visão e este passo ainda não gastou o seu. */
export async function attachVisionFallback(outcome: Outcome, ctx: Pick<ToolContext, "manager" | "getSessionId" | "canSeeImages" | "claimVisionFallback">): Promise<ToolResult> {
	const { vision, ...result } = outcome;
	if (!vision || result.image || !ctx.canSeeImages || !ctx.claimVisionFallback?.()) return result;
	try {
		const shot = await captureModelScreenshot(ctx.manager, await ctx.getSessionId());
		return { ...result, summary: `${result.summary}\n${NOTES[vision]}`, image: shot.dataUrl };
	} catch {
		// Sem tela ou sem screenshot: o texto já é o resultado; a rede de segurança não derruba a tool.
		return result;
	}
}
