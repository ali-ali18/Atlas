import type {
	ControlActResult,
	ControlActionEffect,
	ControlPageChanges,
	ControlBrowserTextOptions,
	ControlBrowserTextResult,
	ControlScrollResult,
} from "@workspace/sandbox";

/** Teto por chamada de `browser_text` (o servidor também limita). */
export const BROWSER_TEXT_MAX_LIMIT = 6000;

/** Valida os args de `browser_text` e devolve só o que o servidor aceita. */
export function parseBrowserTextArgs(
	args: Record<string, unknown>,
): ControlBrowserTextOptions {
	const options: ControlBrowserTextOptions = {};
	if (args.offset !== undefined) {
		const offset = Number(args.offset);
		if (!Number.isFinite(offset) || offset < 0) {
			throw new Error("offset inválido: use um número >= 0 (nextOffset da leitura anterior)");
		}
		options.offset = Math.floor(offset);
	}
	if (args.limit !== undefined) {
		const limit = Number(args.limit);
		if (!Number.isFinite(limit) || limit <= 0) {
			throw new Error("limit inválido: use um número entre 1 e 6000");
		}
		options.limit = Math.min(BROWSER_TEXT_MAX_LIMIT, Math.floor(limit));
	}
	if (args.mode !== undefined) {
		if (args.mode !== "page" && args.mode !== "viewport") {
			throw new Error('mode inválido: use "page" ou "viewport"');
		}
		options.mode = args.mode;
	}
	return options;
}

/** " — posição 1200/5400 (janela 720)" quando o servidor informa o scroll. */
export function formatScrollPosition(position: ControlScrollResult | undefined): string {
	if (!position || typeof position.scrollY !== "number") return "";
	const total = typeof position.scrollHeight === "number" ? `/${position.scrollHeight}` : "";
	const view =
		typeof position.viewportHeight === "number" ? ` (janela ${position.viewportHeight})` : "";
	return ` — posição ${position.scrollY}${total}${view}`;
}

/**
 * Resultado de `browser_text`. O cabeçalho traz offset e scrollY: a chave de
 * repetição da F4 usa o começo do resumo, então ler → rolar → ler de novo
 * (posição diferente) não é tratado como laço.
 */
export function formatBrowserText(result: ControlBrowserTextResult): string {
	const header = `${result.title} (${result.url})`;
	if (typeof result.totalLength !== "number") {
		// Servidor antigo (imagem sem paginação): comportamento anterior.
		return `${header}\n${result.text.slice(0, 1800)}`;
	}
	const offset = result.offset ?? 0;
	const end = offset + result.text.length;
	const where =
		typeof result.scrollY === "number"
			? `; scrollY=${result.scrollY}/${result.scrollHeight ?? "?"}`
			: "";
	const mode = result.mode === "viewport" ? "; visível na janela" : "";
	const more = result.truncated
		? `\n[truncado: há mais texto — chame browser_text com offset=${result.nextOffset ?? end}]`
		: "";
	return `${header}\n[caracteres ${offset}-${end} de ${result.totalLength}${where}${mode}]\n${result.text}${more}`;
}

/**
 * Efeito observado pelo servidor depois da ação: " → URL (navegou)" e aviso
 * quando a página seguia mudando. Vazio para imagens antigas do sandbox.
 */
export function formatSettle(effect: ControlActionEffect | undefined): string {
	if (!effect) return "";
	const parts: string[] = [];
	if (effect.navigated && effect.url) parts.push(`navegou para ${effect.url}`);
	if (effect.settled === false) {
		parts.push("a página ainda estava mudando (leia de novo antes de agir)");
	}
	return parts.length > 0 ? ` — ${parts.join("; ")}` : "";
}

/**
 * V1 — como o clique foi resolvido: só aparece quando houve algo a dizer
 * (alvo trocado, degrau além do clique normal, banner de consentimento).
 */
export function formatClickNote(effect: ControlActionEffect | undefined): string {
	if (!effect) return "";
	const parts: string[] = [];
	if (effect.retargeted) parts.push(`retargeted to the interactive element ${effect.retargeted}`);
	if (effect.rung && effect.rung !== "click") parts.push(`worked via ${effect.rung} step`);
	if (effect.dismissed === "consent") parts.push("dismissed a consent banner (rejected or closed, never accepted)");
	return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/** V1 — `navigate` que devolveu antes do conteúdo montar: avisa em vez de texto vazio. */
export function formatReady(result: { ready?: boolean; hint?: string } | undefined): string {
	if (!result || result.ready !== false) return "";
	return ` — ${result.hint ?? "page is still rendering; call browser_wait or read again"}`;
}

/** `true` quando o servidor novo informou o que mudou (imagens antigas não mandam `waitMs`). */
export function hasChangeReport(effect: Pick<ControlActionEffect, "waitMs" | "changes">): boolean {
	return effect.waitMs !== undefined || effect.changes !== undefined;
}

/** O texto, estado ou diálogo da página mudou? (refs novos e erros são contados à parte) */
export function hasPageChanges(changes: ControlPageChanges | undefined): boolean {
	if (!changes) return false;
	return Boolean(
		changes.added ||
			changes.removedBlocks ||
			changes.states?.length ||
			changes.dialogsOpened?.length ||
			changes.dialogsClosed?.length ||
			changes.title,
	);
}

/** Prefixo dos avisos de verificação; o guard do run conta as ocorrências. */
export const VERIFY_WARNING_PREFIX = "Verification warning:";

/**
 * F12/D1 — o que a ação de fato fez. Devolve um aviso (nunca `ok:false`) quando
 * nada visível mudou depois de um clique/hover/tecla, ou quando o campo ficou
 * com valor diferente do pedido; `null` quando o efeito é claro.
 */
export function verifyActEffect(
	result: Pick<ControlActResult, "action" | "navigated" | "newTotal" | "field" | "errors"> & {
		changes?: ControlPageChanges;
	},
	requested?: string,
): string | null {
	if (result.errors && result.errors.length > 0) {
		return `${VERIFY_WARNING_PREFIX} the page shows a validation error; fix the field it points to before moving on.`;
	}
	if (result.navigated) return null;
	if (result.action === "type" && requested !== undefined && result.field && !result.field.secret) {
		const got = result.field.value;
		const want = requested.replace(/\s+/g, " ").trim().slice(0, 120);
		// Autocomplete pode completar o texto; só avisa se o início não bate.
		if (got !== undefined && want && !got.toLowerCase().startsWith(want.slice(0, 20).toLowerCase())) {
			return `${VERIFY_WARNING_PREFIX} the field holds ${JSON.stringify(got)}, not what was requested. Check with browser_snapshot.`;
		}
		return null;
	}
	const passive = result.action === "click" || result.action === "hover" || result.action === "press";
	if (passive && result.newTotal === 0 && !result.field && !hasPageChanges(result.changes)) {
		return `${VERIFY_WARNING_PREFIX} no visible change after the action. If the page loads slowly use browser_wait; otherwise check with browser_snapshot or a screenshot before repeating or moving on.`;
	}
	return null;
}

/** Não devolve texto longo (TSV de planilha) inteiro no resultado da tool. */
export function describeTypedText(text: string): string {
	if (text.length <= 80) return `"${text}"`;
	const head = text.slice(0, 40).replace(/\s+/g, " ");
	return `${text.length} caracteres (início: "${head}…")`;
}
