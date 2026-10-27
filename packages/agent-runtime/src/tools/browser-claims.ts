/**
 * Portão contra "inventar a tela": o modelo (principalmente um modelo fraco) diz "entrou, painel logado" com a
 * tela em branco. Aqui o runtime só rastreia o que foi OBSERVADO no navegador e decide se uma afirmação sobre a
 * tela pode sair sem conferir. Funções puras; o loop do agente guarda o estado e aplica a revisão (no máximo uma por run).
 */

/** Tools que LEEM a tela/página (valem como conferência). */
const OBSERVE_TOOLS = new Set(["browser_snapshot", "browser_read", "browser_text", "browser_links", "browser_find", "screenshot"]);
/** Tools que MEXEM no navegador (a tela pode ter mudado). */
const ACT_TOOLS = new Set(["navigate", "browser_act", "browser_click", "browser_type", "browser_wait", "click", "type", "key", "scroll", "login_fill", "computer"]);

export type BrowserWatch = {
	/** Registra uma chamada concluída. `summary` é o texto devolvido ao modelo. */
	note(call: { name: string; args?: Record<string, unknown>; ok: boolean; summary: string }): void;
	/** Motivo para pedir conferência antes de afirmar algo da tela, ou null se pode responder. */
	reasonToVerify(finalText: string): "unverified" | "blank-or-login" | null;
};

/** "Título (https://site/pagina)" ou "(about:blank)": a URL que o resultado de uma tool mostra. */
export function extractShownUrl(summary: string): string | null {
	const paren = /\((about:[^)\s]*|chrome:\/\/[^)\s]*|https?:\/\/[^)\s]+)\)/.exec(summary);
	if (paren) return paren[1]!;
	const labeled = /\burl:\s*(about:\S+|https?:\/\/\S+)/i.exec(summary);
	return labeled ? labeled[1]! : null;
}

const LOGIN_PATH = /(^|[/._-])(login|log-in|signin|sign-in|entrar|acessar|auth|sso|logon)([/._?#-]|$)/i;

/** about:blank, nova aba ou uma página de entrada: não prova que está logado. */
export function isBlankOrLoginUrl(url: string): boolean {
	if (/^(about:blank|about:newtab|chrome:\/\/newtab|chrome:\/\/new-tab-page)/i.test(url)) return true;
	try {
		const parsed = new URL(url);
		return LOGIN_PATH.test(`${parsed.pathname}${parsed.hash}`);
	} catch {
		return false;
	}
}

const strip = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const CLAIM_PATTERNS: readonly RegExp[] = [
	// pt
	/\b(entrei|entrou|loguei|logou|consegui entrar|fiz (o )?login|login (feito|realizado|concluido|ok)|acesso (feito|realizado|liberado))\b/,
	/\b(logad[oa]s?|autenticad[oa]s?)\b/,
	/\b(a|na) (tela|pagina) (mostra|exibe|esta|aparece|carregou)\b/,
	/\bo (painel|dashboard|site|sistema) (mostra|exibe|esta (aberto|carregado|logado)|carregou)\b/,
	// en
	/\b(logged|signed) in\b/,
	/\b(i'?m|i am|we'?re|you'?re) (now )?in\b/,
	/\bthe (screen|page|dashboard|panel) (shows|displays|is showing|has loaded)\b/,
	// es
	/\b(inicie sesion|sesion iniciada|estoy dentro|la pantalla muestra)\b/,
];

/** O texto final afirma um estado do navegador ("entrou", "está logado", "a tela mostra…")? */
export function claimsBrowserState(text: string): boolean {
	// "Entrei em contato com..." não é estado do navegador.
	const plain = strip(text).replace(/\b(entrei|entrou) em contato\b/g, "");
	return CLAIM_PATTERNS.some((pattern) => pattern.test(plain));
}

export function createBrowserWatch(): BrowserWatch {
	let touched = false;
	/** Houve ação no navegador depois da última leitura da tela? */
	let actedSinceLook = false;
	let lastShownUrl: string | null = null;
	return {
		note({ name, args, ok, summary }) {
			if (!ok) return;
			const isScreenshotAction = name === "computer" && args?.action === "screenshot";
			const observes = OBSERVE_TOOLS.has(name) || isScreenshotAction;
			const acts = ACT_TOOLS.has(name) && !isScreenshotAction;
			if (!observes && !acts) return;
			touched = true;
			if (observes) actedSinceLook = false;
			if (acts) actedSinceLook = true;
			const url = extractShownUrl(summary);
			if (url) lastShownUrl = url;
		},
		reasonToVerify(finalText) {
			if (!touched || !claimsBrowserState(finalText)) return null;
			if (actedSinceLook) return "unverified";
			if (lastShownUrl && isBlankOrLoginUrl(lastShownUrl)) return "blank-or-login";
			return null;
		},
	};
}

/** Nota ao modelo (inglês) quando a resposta afirma o estado da tela sem conferir. */
export const SCREEN_CLAIM_NOTE =
	"Your draft states what the browser or screen shows (for example that you are signed in), but you have not looked at the screen since your last browser action, or the last page you saw is blank or a login page. " +
	"Verify the current screen with browser_snapshot before claiming its state, then answer only from what you see. If it is still blank or a login page, say so plainly instead of claiming success.";
