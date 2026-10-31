/**
 * F12/B5 — muro de login. Funções puras: decidem, a partir do que o sandbox
 * devolveu (URL, título, linhas do snapshot ou texto da página), se o agente
 * parou numa tela de login. O modelo nunca recebe nem digita senha: ao
 * detectar, o runtime pausa o run e pede ao usuário que faça login no viewer.
 */

export type LoginWallInput = {
	url: string;
	title?: string;
	/** Linhas do `browser_snapshot` (`[e3] textbox "Senha" ...`). */
	lines?: readonly string[];
	/** Texto da página (`browser_text`). */
	text?: string;
};

export type LoginWall = {
	/** Host legível para o card ("Preciso que você faça login em <site>"). */
	site: string;
	/** Chave de "já perguntei": origem + caminho, sem query/hash. */
	key: string;
	reason: "password-field" | "login-page" | "session-expired";
};

const LOGIN_URL = /(^|[/._-])(login|log-in|signin|sign-in|entrar|acesso|acessar|auth|sso|session|logon)([/._?-]|$)/i;
const LOGIN_TITLE = /\b(login|log in|sign in|entrar|acessar|faça login|fazer login|acesse sua conta)\b/i;
const CREDENTIAL_WORDS = /\b(senha|password|usu[aá]rio|e-?mail|login)\b/i;
const SESSION_EXPIRED = /(sua sess[aã]o (expirou|foi encerrada|expirada)|session (has )?expired|sess[aã]o expirada|fa[cç]a login (novamente|para continuar)|please (log|sign) in)/i;

export function loginKey(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
	} catch {
		return url.slice(0, 200);
	}
}

export function siteOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url.slice(0, 80);
	}
}

/** Há campo de senha entre as linhas do snapshot? */
export function hasPasswordField(lines: readonly string[] | undefined): boolean {
	return (lines ?? []).some((line) => line.includes("(campo de senha"));
}

export function detectLoginWall(input: LoginWallInput): LoginWall | null {
	const url = input.url ?? "";
	if (!/^https?:/i.test(url)) return null;
	const base = { site: siteOf(url), key: loginKey(url) };
	const text = input.text ?? "";
	const joinedLines = (input.lines ?? []).join("\n");
	const urlLooksLogin = LOGIN_URL.test(safePath(url));
	const titleLooksLogin = LOGIN_TITLE.test(input.title ?? "");

	if (hasPasswordField(input.lines)) {
		return { ...base, reason: "password-field" };
	}
	if (SESSION_EXPIRED.test(text) || SESSION_EXPIRED.test(joinedLines)) {
		return { ...base, reason: "session-expired" };
	}
	// SSO pode aparecer em /home com título do produto, sem URL de login nem
	// senha. Exija controles reais de SSO + e-mail + continuar; texto de blog
	// ou um botão Google isolado não identifica uma sessão interrompida.
	const ssoButton = /\b(?:button|link)\s+"(?:continue with|sign in with|log in with|continuar com|entrar com) (?:google|apple|microsoft|github|slack)"/i;
	const emailInput = /\btextbox\s+"[^"\n]*\b(?:e-?mail|email address)\b[^"\n]*"/i;
	const continueButton = /\bbutton\s+"(?:continue|continuar|entrar|sign in|log in)"/i;
	if (ssoButton.test(joinedLines) && emailInput.test(joinedLines) && continueButton.test(joinedLines)) {
		return { ...base, reason: "login-page" };
	}
	// Página de entrada sem textbox (Linear): só botões de provedor de identidade
	// ("Continue with Google/email/SAML SSO", "Log in with passkey") ou um rótulo
	// "Log in to <app>" numa página enxuta. Exige 2+ entradas distintas, para que
	// um botão Google isolado numa tela de conteúdo não pause o run.
	if (countIdentityEntries(input.lines) >= 2 || hasLoginToLabel(input.lines)) {
		return { ...base, reason: "login-page" };
	}
	// Texto da página (sem snapshot): "Senha"/"Password" + sinal de login na URL/título.
	if ((urlLooksLogin || titleLooksLogin) && CREDENTIAL_WORDS.test(`${text}\n${joinedLines}`)) {
		return { ...base, reason: "login-page" };
	}
	return null;
}

function safePath(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.pathname}${parsed.hash}`;
	} catch {
		return url;
	}
}

const IDENTITY_ENTRY = /\b(?:button|link|clickable)\s+"(?:continue|continuar|sign in|log in|login|entrar)\s+(?:with|com)\s+(?:google|apple|microsoft|github|gitlab|slack|facebook|linkedin|sso|saml|e-?mail|passkey|a passkey|okta)\b/gi;
const LOGIN_TO_LABEL = /\b(?:button|link|clickable|heading)\s+"(?:log in|sign in|login)\s+to\s+\S/i;
const INTERACTIVE_LINE = /\b(?:button|link|clickable|textbox|checkbox|combobox|menuitem|tab)\b/i;
/** "Log in to <app>" com poucos elementos de conteúdo: página de entrada, não app. */
const LOGIN_TO_MAX_INTERACTIVE = 12;

function countIdentityEntries(lines: readonly string[] | undefined): number {
	const found = new Set<string>();
	for (const line of lines ?? []) {
		for (const match of line.matchAll(IDENTITY_ENTRY)) found.add(match[0].toLowerCase());
	}
	return found.size;
}

function hasLoginToLabel(lines: readonly string[] | undefined): boolean {
	const all = lines ?? [];
	if (!all.some((line) => LOGIN_TO_LABEL.test(line))) return false;
	return all.filter((line) => INTERACTIVE_LINE.test(line)).length <= LOGIN_TO_MAX_INTERACTIVE;
}

/**
 * Login do Cofre que casa com o site da tela de login: o card oferece
 * "Entrar com o login do Cofre". Só metadados (nome, rótulo, usuário, domínio):
 * senha e código 2FA nunca saem do cofre.
 */
export type LoginVaultOffer = {
	name: string;
	label: string;
	username?: string;
	domain: string;
	/** Nome do conector de e-mail conectado ("Gmail"): o "Entrar" também busca o código por e-mail. */
	emailCode?: string;
};

export function parseLoginVaultOffer(raw: unknown): LoginVaultOffer | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.name !== "string" || !row.name.trim() || typeof row.domain !== "string" || !row.domain.trim()) return null;
	return {
		name: row.name.slice(0, 64),
		label: typeof row.label === "string" ? row.label.slice(0, 120) : "",
		...(typeof row.username === "string" && row.username ? { username: row.username.slice(0, 200) } : {}),
		domain: row.domain.slice(0, 120),
		...(typeof row.emailCode === "string" && row.emailCode ? { emailCode: row.emailCode.slice(0, 60) } : {}),
	};
}

/**
 * Passo extra depois de preencher o login (código por e-mail/SMS, 2FA, passkey,
 * captcha, SSO): só uma pessoa resolve. Texto da página ou linhas do snapshot.
 */
const EXTRA_STEP =
	/(c[oó]digo (de )?(verifica[cç][aã]o|seguran[cç]a|confirma[cç][aã]o)|verification code|security code|enter (the|your) code|two-?factor|2-?step|autentica[cç][aã]o (em|de) (dois|duas)|passkey|chave de acesso|check your (e-?mail|inbox|phone)|verifique (seu|o) e-?mail|we (sent|emailed) you|enviamos (um|o) c[oó]digo|verify (it'?s|that it'?s) you|confirme que [ée] voc[eê]|(continue|sign in|log in|entrar|continuar) (with|com) (google|apple|microsoft|sso)|captcha|not a robot|n[aã]o sou um rob[oô]|are you a human|verifique que voc[eê] [ée] humano)/i;

/** A página pede um código enviado por e-mail (e não captcha/passkey/SSO). */
const EMAIL_CODE_STEP =
	/(c[oó]digo (de )?(verifica[cç][aã]o|seguran[cç]a|confirma[cç][aã]o)|verification code|security code|enter (the|your) code|digite o c[oó]digo|check your (e-?mail|inbox)|verifique (seu|o) e-?mail|we (sent|emailed) you|enviamos (um|o) c[oó]digo)/i;
const NOT_EMAIL_CODE = /(captcha|not a robot|n[aã]o sou um rob[oô]|passkey|chave de acesso|authenticator|aplicativo autenticador|authentication app|sms|text message|mensagem de texto)/i;

export function detectEmailCodeStep(input: { text?: string; lines?: readonly string[]; title?: string }): boolean {
	const all = [input.title ?? "", input.text ?? "", ...(input.lines ?? [])].join(" | ");
	return EMAIL_CODE_STEP.test(all) && !NOT_EMAIL_CODE.test(all);
}

export function detectExtraLoginStep(input: { text?: string; lines?: readonly string[]; title?: string }): boolean {
	return EXTRA_STEP.test(`${input.title ?? ""}\n${input.text ?? ""}\n${(input.lines ?? []).join("\n")}`);
}

/**
 * A mensagem do usuário é só a confirmação de "terminei o login"? Curta e sem mais nada (pt/en/es).
 * Qualquer outra fala (pergunta, instrução, "o cofre está como X") é conversa e vai para o modelo.
 */
const LOGIN_CONFIRMATION = new Set([
	"pronto", "prontinho", "terminei", "terminado", "feito", "loguei", "logado", "logada", "entrei", "ok", "okay", "blz", "beleza", "fiz", "ja fiz", "ja terminei", "ja loguei", "ja entrei", "ja esta", "concluido", "pode continuar", "pode seguir", "continue", "continua",
	"done", "finished", "logged in", "i logged in", "im logged in", "i am logged in", "all set", "ready", "i did it", "i am done", "im done", "go ahead", "continue",
	"listo", "lista", "hecho", "termine", "ya", "ya esta", "ya termine", "ya entre", "ya inicie sesion", "inicie sesion", "puedes continuar", "continua", "sigue",
]);

export function isLoginConfirmationText(text: string): boolean {
	const clean = text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/['’`]/g, "")
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!clean || clean.length > 40) return false;
	return LOGIN_CONFIRMATION.has(clean);
}
