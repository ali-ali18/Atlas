// Máquina de estados e validações do login. Funções puras (sem rede, sem React, `now` injetado), testadas em
// login-flow.test.ts. Os textos seguem o tom de apps/web/lib/i18n/messages/pt-BR/login.ts.

export const CODE_LENGTH = 6;
/** Espera entre dois envios de código. O servidor limita 3 envios por minuto; 30 s evita bater nesse limite. */
export const RESEND_COOLDOWN_MS = 30_000;

export const LOGIN_ERRORS = {
	emailEmpty: "Informe o seu e-mail.",
	emailInvalid: "Esse e-mail não parece válido.",
	codeIncomplete: "Digite os 6 números do código.",
	sendFailed: "Não foi possível enviar o código.",
	network: "Não consegui falar com o servidor. Confira a sua conexão e tente de novo.",
	codeWrong: "Código incorreto. Confira o e-mail e tente de novo.",
	codeExpired: "O código expirou. Peça um novo.",
	codeTooMany: "Muitas tentativas erradas. Peça um novo código.",
	rateLimited: "Muitas tentativas. Espere um minuto e tente de novo.",
	google: "Não consegui entrar com o Google. Tente de novo ou use o código por e-mail.",
	generic: "Não foi possível entrar. Tente de novo.",
} as const;

export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Checagem leve de forma (a decisão é do servidor): algo@algo.algo, sem espaços. */
export function isValidEmail(raw: string): boolean {
	const email = normalizeEmail(raw);
	return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Só dígitos, no máximo 6: aceita colar "123 456" ou "123-456". */
export function sanitizeCode(raw: string): string {
	return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export function isCodeComplete(raw: string): boolean {
	return /^\d{6}$/.test(raw);
}

export type AuthFailureKind = "send" | "verify" | "google";

type ErrorLike = { status?: number; code?: string; message?: string } | null | undefined;

/**
 * Traduz o erro do cliente de autenticação em frase simples. Nunca repassa o texto cru do servidor
 * (nem códigos, nem nomes de campo). `network` vem de falha de fetch (sem status).
 */
export function friendlyAuthError(error: ErrorLike, kind: AuthFailureKind): string {
	if (kind === "google") return LOGIN_ERRORS.google;
	if (!error || ((error.status === undefined || error.status === 0) && !error.code)) return LOGIN_ERRORS.network;
	const code = (error.code ?? "").toUpperCase();
	if (error.status === 429) return LOGIN_ERRORS.rateLimited;
	if (code === "TOO_MANY_ATTEMPTS") return LOGIN_ERRORS.codeTooMany;
	if (code === "OTP_EXPIRED") return LOGIN_ERRORS.codeExpired;
	if (code === "INVALID_OTP") return LOGIN_ERRORS.codeWrong;
	if (kind === "send") return LOGIN_ERRORS.sendFailed;
	if (kind === "verify") return error.status === 400 || error.status === 403 ? LOGIN_ERRORS.codeWrong : LOGIN_ERRORS.generic;
	return LOGIN_ERRORS.generic;
}

export type LoginState = {
	step: "email" | "code";
	email: string;
	code: string;
	/** Operação em andamento: trava os botões. */
	busy: null | "send" | "verify" | "google";
	error: string | null;
	/** Momento (ms) a partir do qual "Reenviar" volta a funcionar. */
	resendAt: number;
};

export const initialLoginState: LoginState = { step: "email", email: "", code: "", busy: null, error: null, resendAt: 0 };

export type LoginEvent =
	| { type: "emailChanged"; value: string }
	| { type: "codeChanged"; value: string }
	| { type: "sendRequested" }
	| { type: "sendSucceeded"; now: number }
	| { type: "sendFailed"; message: string }
	| { type: "verifyRequested" }
	| { type: "verifyFailed"; message: string }
	| { type: "googleRequested" }
	| { type: "googleFinished"; message: string | null }
	| { type: "changeEmail" };

/** Pode reenviar? (depois do tempo de espera e sem operação em andamento) */
export function canResend(state: LoginState, now: number): boolean {
	return state.step === "code" && state.busy === null && now >= state.resendAt;
}

export function resendSecondsLeft(state: LoginState, now: number): number {
	return Math.max(0, Math.ceil((state.resendAt - now) / 1000));
}

export function loginReducer(state: LoginState, event: LoginEvent): LoginState {
	switch (event.type) {
		case "emailChanged":
			return state.step === "email" ? { ...state, email: event.value, error: null } : state;
		case "codeChanged":
			return state.step === "code" ? { ...state, code: sanitizeCode(event.value), error: null } : state;
		case "sendRequested": {
			if (state.busy) return state;
			if (!state.email.trim()) return { ...state, error: LOGIN_ERRORS.emailEmpty };
			if (!isValidEmail(state.email)) return { ...state, error: LOGIN_ERRORS.emailInvalid };
			return { ...state, email: normalizeEmail(state.email), busy: "send", error: null };
		}
		case "sendSucceeded":
			return { ...state, step: "code", code: "", busy: null, error: null, resendAt: event.now + RESEND_COOLDOWN_MS };
		case "sendFailed":
			return { ...state, busy: null, error: event.message };
		case "verifyRequested": {
			if (state.busy || state.step !== "code") return state;
			if (!isCodeComplete(state.code)) return { ...state, error: LOGIN_ERRORS.codeIncomplete };
			return { ...state, busy: "verify", error: null };
		}
		case "verifyFailed":
			return { ...state, busy: null, code: "", error: event.message };
		case "googleRequested":
			return state.busy ? state : { ...state, busy: "google", error: null };
		case "googleFinished":
			return { ...state, busy: null, error: event.message };
		case "changeEmail":
			return { ...state, step: "email", code: "", busy: null, error: null, resendAt: 0 };
	}
}
