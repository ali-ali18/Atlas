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
	/** O runtime mesmo olhou a tela (ex.: conferiu o login ao retomar): conta como leitura. */
	observe(shownUrl?: string): void;
};

/** "Título (https://site/pagina)" ou "(about:blank)": a URL que o resultado de uma tool mostra. */
export function extractShownUrl(summary: string): string | null {
	// `(` fora da classe: cada varredura para no próximo `(`, então o total é linear (antes, "(about:" repetido era quadrático).
	const paren = /\((about:[^()\s]*|chrome:\/\/[^()\s]*|https?:\/\/[^()\s]+)\)/.exec(summary);
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

/** Afirmações que valem em qualquer contexto (já sem acento, minúsculas). */
const CLAIM_PATTERNS: readonly RegExp[] = [
	// pt: "entrou" sozinho é comum demais ("entrou em contato", "entrou em vigor"); exige o destino ou o verbo de login.
	/\b(entrei|entrou) (na|no|nas|nos) (minha |sua |a |o )?(conta|sistema|painel|portal|plataforma|dashboard|area logada|site)\b/,
	/\b(loguei|logou|consegui entrar|fiz (o )?login|login (feito|realizado|concluido|ok)|acesso (feito|realizado|liberado))\b/,
	/\b(o )?login (funcionou|deu certo|foi (feito|realizado|concluido) com sucesso)\b/,
	/\bacessei (o|a|ao|na|no) (site|painel|conta|sistema|pagina|portal|plataforma|dashboard)\b/,
	/\b(logad[oa]s?|autenticad[oa]s?)\b/,
	/\b(a|na) (tela|pagina) (mostra|exibe|esta|aparece|carregou)\b/,
	/\bo site (mostra|exibe|esta (aberto|carregado|logado)|carregou)\b/,
	// en
	/\b(logged|signed) in\b/,
	/\b(i'?m|i am) (now )?in(side)? (the|your) (account|dashboard|panel|portal|system)\b/,
	/\b(the )?login (worked|succeeded|was successful)\b/,
	/\bi (accessed|got into) (the|your) (site|website|account|dashboard|panel|portal|system|page)\b/,
	/\bthe (screen|page|site|website) (shows|displays|is showing|has loaded)\b/,
	// es
	/\b(inicie sesion|sesion iniciada|estoy dentro|la pantalla muestra)\b/,
];

/**
 * "O painel/dashboard/sistema mostra…" também é linguagem do produto (Painéis do próprio bot): só conta como
 * afirmação sobre o navegador quando o texto aponta para um site (URL, domínio, "do site", "no navegador"...).
 */
const GATED_PATTERNS: readonly RegExp[] = [
	/\bo (painel|dashboard|sistema) (d[oae]s? [\w.-]+ )?(mostra|exibe|esta (aberto|carregado|logado)|carregou)\b/,
	/\bthe (dashboard|panel|system)( (at|of|on) \S+)? (shows|displays|is showing|has loaded)\b/,
];
const WEBSITE_HINT = /(https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|app|dev|gov|edu)(\.[a-z]{2})?\b|\b(do|no|da|na|of the|on the) (site|website|navegador|browser|pagina|portal)\b|\b(no|do) painel d[oae]s? [a-z0-9.-]+\.[a-z]{2,}|\bdo site\b)/;

const NEGATION_WORDS = new Set(["nao", "nunca", "jamais", "sem", "not", "never", "cannot", "unable", "failed", "nem", "tampouco", "impossivel"]);
/** A negação tem de estar colada na afirmação ("não consegui entrar", "cannot tell if the login worked"). */
const NEGATION_WINDOW_WORDS = 3;
/** Vírgula e conjunções abrem outra oração: a negação de uma não vale para a seguinte. */
const CLAUSE_BOUNDARY = /,|\b(mas|e|but|and)\b/g;

/** Negação (não/nao/n't/cannot/sem/not...) nas 3 palavras antes do trecho, na mesma frase e na mesma oração. */
function isNegatedBefore(plain: string, index: number): boolean {
	const sentenceStart = Math.max(plain.lastIndexOf(".", index - 1), plain.lastIndexOf("!", index - 1), plain.lastIndexOf("?", index - 1), plain.lastIndexOf("\n", index - 1), plain.lastIndexOf(";", index - 1), plain.lastIndexOf(":", index - 1));
	const clause = plain.slice(sentenceStart + 1, index).split(CLAUSE_BOUNDARY).pop() ?? "";
	const words = clause.split(/\s+/).filter(Boolean).slice(-NEGATION_WINDOW_WORDS);
	return words.some((word) => NEGATION_WORDS.has(word) || /n't$/.test(word) || word === "nt");
}

function hasUnnegatedMatch(plain: string, patterns: readonly RegExp[]): boolean {
	for (const pattern of patterns) {
		const global = new RegExp(pattern.source, "g");
		for (const match of plain.matchAll(global)) {
			if (!isNegatedBefore(plain, match.index ?? 0)) return true;
		}
	}
	return false;
}

/** O texto final afirma um estado do navegador ("entrou na conta", "está logado", "a tela mostra…")? Negações não contam. */
export function claimsBrowserState(text: string): boolean {
	// "é" (verbo) vira "eh" antes de tirar o acento: senão confunde com a conjunção "e" (limite de oração).
	const plain = strip(text.replace(/(^|[^\p{L}])é(?![\p{L}])/giu, "$1eh")).replace(/[’‘]/g, "'");
	if (hasUnnegatedMatch(plain, CLAIM_PATTERNS)) return true;
	return WEBSITE_HINT.test(plain) && hasUnnegatedMatch(plain, GATED_PATTERNS);
}

export function createBrowserWatch(options: { resumedWithBrowser?: boolean } = {}): BrowserWatch {
	// Run retomado (checkpoint) que já usou o navegador: o estado da tela vem de antes e o que foi lido não
	// sobreviveu à retomada, então vale como "mexeu e ainda não conferiu" até olhar a tela de novo.
	const resumed = options.resumedWithBrowser === true;
	let touched = resumed;
	/** Houve ação no navegador depois da última leitura da tela? */
	let actedSinceLook = resumed;
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
		observe(shownUrl) {
			actedSinceLook = false;
			if (shownUrl) lastShownUrl = shownUrl;
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
