import { describe, expect, it } from "vitest";
import {
	CODE_LENGTH,
	LOGIN_ERRORS,
	RESEND_COOLDOWN_MS,
	canResend,
	friendlyAuthError,
	initialLoginState,
	isCodeComplete,
	isValidEmail,
	loginReducer,
	normalizeEmail,
	resendSecondsLeft,
	sanitizeCode,
	type LoginEvent,
	type LoginState,
} from "./login-flow";

const run = (events: LoginEvent[], from: LoginState = initialLoginState) => events.reduce(loginReducer, from);

describe("e-mail", () => {
	it("normaliza caixa e espaços", () => {
		expect(normalizeEmail("  Dono@Exemplo.COM ")).toBe("dono@exemplo.com");
	});
	it("valida a forma", () => {
		expect(isValidEmail("dono@exemplo.com")).toBe(true);
		for (const bad of ["", "dono", "dono@", "@exemplo.com", "dono@exemplo", "do no@exemplo.com", `${"a".repeat(250)}@x.co`]) {
			expect(isValidEmail(bad), bad).toBe(false);
		}
	});
});

describe("código", () => {
	it("deixa só dígitos e corta em 6", () => {
		expect(sanitizeCode("12a3-45 6789")).toBe("123456");
		expect(sanitizeCode("")).toBe("");
		expect(sanitizeCode("abc")).toBe("");
		expect(sanitizeCode("1234567890")).toHaveLength(CODE_LENGTH);
	});
	it("só 6 dígitos completam", () => {
		expect(isCodeComplete("123456")).toBe(true);
		for (const bad of ["", "12345", "1234567", "12345a", "123 56"]) expect(isCodeComplete(bad), bad).toBe(false);
	});
});

describe("friendlyAuthError", () => {
	it("sem resposta do servidor é erro de rede", () => {
		expect(friendlyAuthError(undefined, "verify")).toBe(LOGIN_ERRORS.network);
		expect(friendlyAuthError({ status: 0 }, "send")).toBe(LOGIN_ERRORS.network);
	});
	it("mapeia os códigos do código de acesso", () => {
		expect(friendlyAuthError({ status: 400, code: "INVALID_OTP" }, "verify")).toBe(LOGIN_ERRORS.codeWrong);
		expect(friendlyAuthError({ status: 400, code: "OTP_EXPIRED" }, "verify")).toBe(LOGIN_ERRORS.codeExpired);
		expect(friendlyAuthError({ status: 403, code: "TOO_MANY_ATTEMPTS" }, "verify")).toBe(LOGIN_ERRORS.codeTooMany);
		expect(friendlyAuthError({ status: 429 }, "send")).toBe(LOGIN_ERRORS.rateLimited);
	});
	it("não repassa o texto do servidor", () => {
		const text = friendlyAuthError({ status: 500, message: "PrismaClientKnownRequestError: secret" }, "send");
		expect(text).toBe(LOGIN_ERRORS.sendFailed);
		expect(text).not.toMatch(/prisma|secret/i);
		expect(friendlyAuthError({ status: 500 }, "google")).toBe(LOGIN_ERRORS.google);
	});
});

describe("loginReducer", () => {
	it("começa no e-mail", () => {
		expect(initialLoginState.step).toBe("email");
	});

	it("recusa e-mail vazio ou inválido sem ocupar", () => {
		expect(run([{ type: "sendRequested" }]).error).toBe(LOGIN_ERRORS.emailEmpty);
		const bad = run([{ type: "emailChanged", value: "dono" }, { type: "sendRequested" }]);
		expect(bad).toMatchObject({ busy: null, error: LOGIN_ERRORS.emailInvalid, step: "email" });
	});

	it("enviar: ocupa, normaliza o e-mail e, ao dar certo, vai para o código com espera", () => {
		const sending = run([{ type: "emailChanged", value: " Dono@Exemplo.com " }, { type: "sendRequested" }]);
		expect(sending).toMatchObject({ busy: "send", email: "dono@exemplo.com", error: null });
		const sent = loginReducer(sending, { type: "sendSucceeded", now: 1000 });
		expect(sent).toMatchObject({ step: "code", busy: null, code: "", resendAt: 1000 + RESEND_COOLDOWN_MS });
	});

	it("não dispara dois envios ao mesmo tempo", () => {
		const sending = run([{ type: "emailChanged", value: "dono@exemplo.com" }, { type: "sendRequested" }]);
		expect(loginReducer(sending, { type: "sendRequested" })).toBe(sending);
	});

	it("falha no envio volta para o e-mail com a mensagem", () => {
		const s = run([{ type: "emailChanged", value: "dono@exemplo.com" }, { type: "sendRequested" }, { type: "sendFailed", message: "x" }]);
		expect(s).toMatchObject({ step: "email", busy: null, error: "x" });
	});

	const atCode = () => run([{ type: "emailChanged", value: "dono@exemplo.com" }, { type: "sendRequested" }, { type: "sendSucceeded", now: 0 }]);

	it("só aceita código no passo do código e só dígitos", () => {
		expect(loginReducer(initialLoginState, { type: "codeChanged", value: "123456" }).code).toBe("");
		expect(loginReducer(atCode(), { type: "codeChanged", value: "12 34-56" }).code).toBe("123456");
	});

	it("verificar exige 6 dígitos", () => {
		const s = run([{ type: "codeChanged", value: "123" }, { type: "verifyRequested" }], atCode());
		expect(s).toMatchObject({ busy: null, error: LOGIN_ERRORS.codeIncomplete });
		const ok = run([{ type: "codeChanged", value: "123456" }, { type: "verifyRequested" }], atCode());
		expect(ok.busy).toBe("verify");
	});

	it("código errado limpa o campo e mostra o erro", () => {
		const s = run([{ type: "codeChanged", value: "123456" }, { type: "verifyRequested" }, { type: "verifyFailed", message: "errado" }], atCode());
		expect(s).toMatchObject({ busy: null, code: "", error: "errado", step: "code" });
	});

	it("reenviar só depois da espera", () => {
		const s = atCode();
		expect(canResend(s, 1)).toBe(false);
		expect(resendSecondsLeft(s, 1)).toBe(30);
		expect(canResend(s, RESEND_COOLDOWN_MS)).toBe(true);
		expect(resendSecondsLeft(s, RESEND_COOLDOWN_MS)).toBe(0);
		expect(canResend({ ...s, busy: "verify" }, RESEND_COOLDOWN_MS)).toBe(false);
		expect(canResend(initialLoginState, 10 ** 9)).toBe(false);
	});

	it("trocar e-mail volta ao início e limpa o código, mantendo o e-mail digitado", () => {
		const s = run([{ type: "codeChanged", value: "123456" }, { type: "changeEmail" }], atCode());
		expect(s).toMatchObject({ step: "email", code: "", email: "dono@exemplo.com", resendAt: 0, error: null });
	});

	it("Google: ocupa e termina com ou sem erro", () => {
		const s = run([{ type: "googleRequested" }]);
		expect(s.busy).toBe("google");
		expect(loginReducer(s, { type: "googleRequested" })).toBe(s);
		expect(loginReducer(s, { type: "googleFinished", message: "falhou" })).toMatchObject({ busy: null, error: "falhou" });
		expect(loginReducer(s, { type: "googleFinished", message: null })).toMatchObject({ busy: null, error: null });
	});
});
