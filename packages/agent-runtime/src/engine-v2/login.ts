/**
 * Motor v2: um card de login por site e conversa (a cada 30 min), como no v1. Se o mesmo site já tem um card
 * pendente, o run não abre outro: o modelo recebe a nota "LOGIN STILL REQUIRED" no lugar do pedido. Puro.
 */
import type { ComputerUseEvent } from "@workspace/shared";
import { LOGIN_ALREADY_ASKED_NOTE, UNATTENDED_LOGIN_NOTE } from "../computer-use.js";

type LoginEvent = Extract<ComputerUseEvent, { type: "login" }>;

const LOGIN_REQUIRED_MARKER = "\nLOGIN REQUIRED on";

export function dedupeLoginAsk(input: { event: LoginEvent; summary: string; asked: Set<string> }): { event?: LoginEvent; summary: string } {
	const { event } = input;
	// Captcha e login de conector não repetem por site: sempre pedem à pessoa.
	if (event.reason === "captcha" || event.connector || event.composioToolkit) return { event, summary: input.summary };
	if (input.asked.has(event.site)) {
		const at = input.summary.indexOf(LOGIN_REQUIRED_MARKER);
		const base = at >= 0 ? input.summary.slice(0, at) : input.summary;
		return { summary: `${base}${LOGIN_ALREADY_ASKED_NOTE(event.site)}` };
	}
	input.asked.add(event.site);
	return { event, summary: input.summary };
}

/**
 * Rotina/webhook não tem quem faça login: sem cartão e sem pausa (um login pendente sequestraria o próximo chat).
 * O modelo recebe a nota e termina com uma mensagem clara ao dono, como no v1. Captcha e login de conector
 * seguem pedindo à pessoa.
 */
export function unattendedLoginOutcome(input: { event: LoginEvent; summary: string; unattended: boolean }): { event?: LoginEvent; summary: string } {
	const { event } = input;
	if (!input.unattended || event.reason === "captcha" || event.connector || event.composioToolkit) return { event, summary: input.summary };
	const at = input.summary.indexOf(LOGIN_REQUIRED_MARKER);
	const base = at >= 0 ? input.summary.slice(0, at) : input.summary;
	return { summary: `${base}${UNATTENDED_LOGIN_NOTE(event.site, event.vaultTried)}` };
}
