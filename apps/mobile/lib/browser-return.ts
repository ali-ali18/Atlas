// Saber se o navegador do login FECHOU. iOS: `openBrowserAsync` só resolve ao fechar (`cancel`/`dismiss`). Android: ele
// resolve logo ao abrir, com `{ type: "opened" }`; ali o fechamento só aparece como o app voltando ao primeiro plano
// (AppState vai a background/inactive e volta a active). Por isso a assinatura do AppState tem de existir ANTES de abrir.

/** Fonte de mudanças do AppState, injetada (no app: `AppState.addEventListener("change", ...)`). */
export type AppStateSource = { subscribe: (listener: (state: string) => void) => () => void };

export const NEVER_CHANGES: AppStateSource = { subscribe: () => () => {} };

export type BrowserCloseTracker = {
	/** Resultado do `openBrowserAsync` (ou `null` se ele falhou). */
	settle: (result: { type?: unknown } | null | undefined) => void;
	/** O navegador de fato fechou? */
	closed: () => boolean;
	dispose: () => void;
};

export function createBrowserCloseTracker(source: AppStateSource): BrowserCloseTracker {
	let left = false;
	let returned = false;
	// `null` = ainda não resolveu; `"opened"` = Android/web (só o retorno ao app conta); outro = fechou.
	let result: "pending" | "opened" | "closed" = "pending";
	const unsubscribe = source.subscribe((state) => {
		if (state === "background" || state === "inactive") left = true;
		else if (state === "active" && left) returned = true;
	});
	return {
		settle(value) {
			result = value && value.type === "opened" ? "opened" : "closed";
		},
		closed: () => result === "closed" || (result === "opened" && returned),
		dispose: unsubscribe,
	};
}
