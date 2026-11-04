// Cópia de feat/mobile-aplicativos (mesmo conteúdo): unificar quando as duas branches entrarem na main.
// Saber se o navegador do login FECHOU. iOS: `openBrowserAsync` só resolve ao fechar (`cancel`/`dismiss`). Android: ele
// resolve logo ao abrir, com `{ type: "opened" }`; ali o fechamento só aparece como o app voltando ao primeiro plano
// (AppState vai a background/inactive e volta a active). Por isso a assinatura do AppState tem de existir ANTES de abrir.
// Uma ida e volta curta (copiar o código 2FA em outro app) não é fechar: depois de voltar há uma janela de graça em que a
// conferência continua; se o app sair de novo nela, volta-se a esperar.

/** Fonte de mudanças do AppState, injetada (no app: `AppState.addEventListener("change", ...)`). */
export type AppStateSource = { subscribe: (listener: (state: string) => void) => () => void };

export const NEVER_CHANGES: AppStateSource = { subscribe: () => () => {} };

/** Quanto tempo o app precisa ficar de volta ao primeiro plano para o navegador valer como fechado (Android). */
export const RETURN_GRACE_MS = 15_000;

export type BrowserCloseTracker = {
	/** Resultado do `openBrowserAsync` (ou `null` se ele falhou). */
	settle: (result: { type?: unknown } | null | undefined) => void;
	/** O navegador de fato fechou? */
	closed: () => boolean;
	dispose: () => void;
};

export function createBrowserCloseTracker(source: AppStateSource, now: () => number = Date.now, graceMs: number = RETURN_GRACE_MS): BrowserCloseTracker {
	let left = false;
	let returnedAt: number | null = null;
	// `"opened"` = Android/web (só o retorno ao app, sustentado, conta); `"closed"` = iOS (cancel/dismiss) ou falha ao abrir.
	let result: "pending" | "opened" | "closed" = "pending";
	const unsubscribe = source.subscribe((state) => {
		if (state === "background" || state === "inactive") {
			left = true;
			returnedAt = null;
		} else if (state === "active" && left) {
			left = false;
			returnedAt = now();
		}
	});
	return {
		settle(value) {
			result = value && value.type === "opened" ? "opened" : "closed";
		},
		closed: () => result === "closed" || (result === "opened" && returnedAt !== null && now() - returnedAt >= graceMs),
		dispose: unsubscribe,
	};
}
