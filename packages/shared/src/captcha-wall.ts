/**
 * F12/D3 — captcha e bloqueio anti-bot. Funções puras: a partir de URL,
 * título e texto/linhas devolvidos pelo sandbox, dizem se há um desafio que
 * SÓ uma pessoa resolve (captcha) para o runtime pedir ajuda no viewer da VM.
 * Bloqueio sem desafio (Cloudflare, "acesso negado") não é resolvível: o
 * agente deve trocar de fonte (a detecção textual fica em `jev/block-page`).
 */
import { loginKey, siteOf } from "./login-wall.js";

export type CaptchaWallInput = {
	url: string;
	title?: string;
	lines?: readonly string[];
	text?: string;
};

export type CaptchaWall = {
	site: string;
	/** Chave de "já perguntei": mesma forma de `loginKey`, com prefixo `captcha:`. */
	key: string;
};

const CAPTCHA_URL =
	/(^https?:\/\/(www\.)?google\.[a-z.]+\/sorry\b|\/recaptcha\/|hcaptcha\.com|challenges\.cloudflare\.com|captcha-delivery\.com|\/captcha\b|[?&]captcha=)/i;
const CAPTCHA_TEXT =
	/\b(captcha|recaptcha|hcaptcha|turnstile)\b|unusual traffic|n[aã]o sou um rob[oô]|i['’]m not a robot|verifique que voc[eê] [eé] humano|verify (that )?you are (a )?human|press (&|and) hold|confirm you are human|tr[aá]fego incomum/i;

export function detectCaptchaWall(input: CaptchaWallInput): CaptchaWall | null {
	const url = input.url ?? "";
	if (!/^https?:/i.test(url)) return null;
	const body = `${input.title ?? ""}\n${(input.lines ?? []).join("\n")}\n${input.text ?? ""}`;
	if (!CAPTCHA_URL.test(url) && !CAPTCHA_TEXT.test(body.slice(0, 6_000))) return null;
	return { site: siteOf(url), key: `captcha:${loginKey(url)}` };
}
