import { detectLoginWall, hasOneTimeCodeField, hasPasswordField } from "@workspace/shared";
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

type ClickEffect = Pick<ControlActionEffect, "navigated" | "changes" | "errors" | "newElements" | "pointer"> & { field?: { secret?: boolean } };

/**
 * Clique que não navegou nem trouxe NADA de visível (texto, título, bloco removido, estado, diálogo
 * aberto ou fechado, erro, elemento novo): o efeito pode estar só na tela. Servidor antigo (sem
 * `changes`) não diz nada sobre a página, então não vale como "silencioso".
 */
export function isSilentClick(effect: ClickEffect): boolean {
	if (effect.navigated) return false;
	if (effect.errors?.length || effect.newElements?.length) return false;
	const changes = effect.changes;
	if (!changes) return false;
	if (changes.reloaded || changes.added || changes.title || changes.removedBlocks) return false;
	if (changes.states?.length || changes.dialogsOpened?.length || changes.dialogsClosed?.length) return false;
	return true;
}

/** Ação sobre campo de senha/segredo: a tela pode mostrar o que foi digitado, então nunca vira screenshot automático. */
export function touchesSecret(effect: Pick<ClickEffect, "pointer" | "field">): boolean {
	return effect.pointer?.sensitive === true || effect.field?.secret === true;
}

/** `{ vision }` para o resultado de um clique: só quando o clique foi silencioso e não tocou em segredo. */
export function clickVision(effect: ClickEffect): { vision?: VisionReason } {
	return isSilentClick(effect) && !touchesSecret(effect) ? { vision: "silent-click" } : {};
}

/**
 * A tela atual tem campo de senha, de código de uso único ou é uma parede de login (sinal estrutural do
 * snapshot, o mesmo que pausa o run para o login)? Sem como conferir, trata como sensível.
 */
async function pageIsSensitive(manager: Pick<ToolContext["manager"], "execBrowserSnapshot">, sessionId: string): Promise<boolean> {
	try {
		const snapshot = await manager.execBrowserSnapshot(sessionId, { area: "viewport" });
		const lines = snapshot.lines ?? [];
		return hasPasswordField(lines) || hasOneTimeCodeField(lines) || Boolean(detectLoginWall({ url: snapshot.url, title: snapshot.title, lines }));
	} catch {
		return true;
	}
}

type Outcome = { summary: string; vision?: VisionReason } & Partial<ToolResult>;

/** Anexa o screenshot quando o resultado pede visão e este passo ainda não gastou o seu. */
export async function attachVisionFallback(outcome: Outcome, ctx: Pick<ToolContext, "manager" | "getSessionId" | "canSeeImages" | "claimVisionFallback">): Promise<ToolResult> {
	const { vision, ...result } = outcome;
	if (!vision || result.image || !ctx.canSeeImages || !ctx.claimVisionFallback) return result;
	try {
		const sessionId = await ctx.getSessionId();
		// Antes de gastar o passo: tela de login/senha nunca vai para o modelo como imagem.
		if (await pageIsSensitive(ctx.manager, sessionId)) return result;
		if (!ctx.claimVisionFallback()) return result;
		const shot = await captureModelScreenshot(ctx.manager, sessionId);
		return { ...result, summary: `${result.summary}\n${NOTES[vision]}`, image: shot.dataUrl };
	} catch {
		// Sem tela ou sem screenshot: o texto já é o resultado; a rede de segurança não derruba a tool.
		return result;
	}
}
