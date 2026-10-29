import { getActiveTranslator } from "@/lib/i18n/active";
import type { Translator } from "@/lib/i18n/translator";
import type { ComposioConnectedAppView, ComposioStatusView, ComposioToolkitView } from "@workspace/shared";

/** Estado puro da seção Composio (sem React), testável em unidade. */

export type ComposioViewState = "loading" | "off" | "on";

export const COMPOSIO_SITE_URL = "https://composio.dev";

export function composioViewState(status: ComposioStatusView | null): ComposioViewState {
	if (!status) return "loading";
	return status.configured ? "on" : "off";
}

/** Só abre o login em `composio.dev` (a API devolve o link; não confiamos cegamente). */
export function isComposioConnectUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
	} catch {
		return false;
	}
}

/** Apps ainda não conectados (os conectados aparecem na própria lista). */
export function availableToolkits(
	toolkits: readonly ComposioToolkitView[],
	connections: readonly ComposioConnectedAppView[],
): ComposioToolkitView[] {
	const connected = new Set(connections.map((app) => app.toolkit));
	return toolkits.filter((toolkit) => !toolkit.connected && !connected.has(toolkit.slug.toLowerCase()));
}

/** App sem login: o botão ativa/desativa em vez de conectar/desconectar. */
export function composioConnectLabel(noAuth: boolean | undefined, { t }: Translator = getActiveTranslator()): string {
	return noAuth ? t("settings.composio.activate") : t("settings.composio.connect");
}

export function composioDisconnectLabel(noAuth: boolean | undefined, { t }: Translator = getActiveTranslator()): string {
	return noAuth ? t("settings.composio.deactivate") : t("settings.composio.disconnect");
}

export const composioNoAuthBadge = ({ t }: Translator = getActiveTranslator()): string => t("settings.composio.noAuthBadge");

/** Texto fixo em pt-BR, mantido para quem ainda importa a constante (Marketplace); prefira `composioNoAuthBadge()`. */
export const COMPOSIO_NO_AUTH_BADGE = "Sem login";

export function nativeToolkitNote(toolkit: Pick<ComposioToolkitView, "nativeCatalogId">, { t }: Translator = getActiveTranslator()): string | null {
	return toolkit.nativeCatalogId ? t("settings.composio.nativeNote") : null;
}

export function composioKeyCaption(status: ComposioStatusView, { t, tn }: Translator = getActiveTranslator()): string {
	const hint = status.keyHint ?? "••••";
	if (status.toolCount === 0) return t("settings.composio.keyCaptionNoTools", { hint });
	return tn("settings.composio.keyCaptionTools", status.toolCount, { hint });
}

/**
 * Paginação por cursor do catálogo. O Composio só dá o cursor da PRÓXIMA página,
 * então guardamos o cursor de cada página já visitada: `cursors[i]` busca a
 * página `i + 1` (a primeira não tem cursor) e "Anterior" só volta o índice.
 */
export type ComposioPager = { cursors: readonly (string | null)[]; index: number };

export const COMPOSIO_FIRST_PAGE: ComposioPager = { cursors: [null], index: 0 };

export function composioPageNumber(pager: ComposioPager): number {
	return pager.index + 1;
}

export function composioPageCursor(pager: ComposioPager): string | null {
	return pager.cursors[pager.index] ?? null;
}

export function composioHasPrev(pager: ComposioPager): boolean {
	return pager.index > 0;
}

/** Avança com o `nextCursor` da página atual; sem cursor (última página) não muda nada. */
export function composioNextPage(pager: ComposioPager, nextCursor: string | null): ComposioPager {
	if (!nextCursor) return pager;
	return { cursors: [...pager.cursors.slice(0, pager.index + 1), nextCursor], index: pager.index + 1 };
}

export function composioPrevPage(pager: ComposioPager): ComposioPager {
	return pager.index > 0 ? { ...pager, index: pager.index - 1 } : pager;
}

/** Busca ou categoria diferente volta para a página 1; o mesmo filtro mantém a página. */
export function composioPagerForFilter(
	pager: ComposioPager,
	previous: { search: string; category: string },
	next: { search: string; category: string },
): ComposioPager {
	return previous.search === next.search && previous.category === next.category ? pager : COMPOSIO_FIRST_PAGE;
}

/** "Página 2 de 14" quando o total é conhecido; senão só "Página 2". */
export function composioPageLabel(pager: ComposioPager, totalItems: number | null, pageSize: number, { t }: Translator = getActiveTranslator()): string {
	const page = composioPageNumber(pager);
	if (!totalItems || totalItems <= 0 || pageSize <= 0) return t("settings.composio.page", { page });
	return t("settings.composio.pageOf", { page, total: Math.max(page, Math.ceil(totalItems / pageSize)) });
}

