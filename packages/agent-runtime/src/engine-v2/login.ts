/**
 * Motor v2: um card de login por site e conversa (a cada 30 min), como no v1. Se o mesmo site já tem um card
 * pendente, o run não abre outro: o modelo recebe a nota "LOGIN STILL REQUIRED" no lugar do pedido. Puro.
 */
import type { ComputerUseEvent } from "@workspace/shared";
import { LOGIN_ALREADY_ASKED_NOTE } from "../computer-use.js";

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
