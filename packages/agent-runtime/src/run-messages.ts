import { type BotLanguage, systemMessages } from "@workspace/shared";

/** Rotina "só importante": o resultado fica salvo no chat sem aviso; `notify_user` é o único jeito de apitar. */
export const USER_PUSH_ROUTINE_NOTE =
	"This routine is set to notify only when something matters. Your final reply is saved in the chat silently, without a notification. Call notify_user (at most once) only if the result is something the user would want to know now; if nothing is new or noteworthy, just write the result and do not call it.";

/** Fechamento padrão quando o run parou por teto e o resumo do modelo não saiu (pt-BR por padrão). */
export function budgetStopFallbackText(reason: string, language: BotLanguage = "pt-BR"): string {
	return systemMessages(language).stopFallback(reason);
}

/** L19: resposta ao modelo quando ele pede uma tool fora do conjunto executável. */
export function unavailableToolMessage(name: string, loadable: boolean, canSearch: boolean, hint = ""): string {
	const message = loadable && canSearch
		? `Tool ${name} is not loaded in this run. Load it with mcp_tool_search first, then call it.`
		: `Tool ${name} is not available in this run. Use one of the tools you were given, or tell the user what is missing.`;
	return hint ? `${message} ${hint}` : message;
}

export const LOGIN_ALREADY_ASKED_NOTE = (site: string) =>
	`\nLOGIN STILL REQUIRED on ${site}: the user was already asked to log in to this site in the last 30 minutes, so no new card was shown. ` +
	"Do NOT ask again, never type credentials. Tell the user plainly (in their language, no technical terms) that the site still shows the login screen " +
	"and that they can open the computer, finish signing in and tell you when it is done.";

export const UNATTENDED_LOGIN_NOTE = (site: string, tried?: string) =>
	`\nLOGIN NOT POSSIBLE on ${site}: this is an unattended routine run, nobody can sign in by hand. Do NOT retry, do NOT call more browser tools, never type credentials. ` +
	(tried
		? "The saved vault login was used but the site still asks for an extra step only the person can do (code, captcha or confirmation). "
		: "No saved vault login matched this site. ") +
	"Finish now with ONE short message to the owner (in their language, plain words, no tool names): say the routine needs to sign in to " + site +
	(tried ? " and that the site asked for an extra step, so they should open the conversation and finish it." : ", that no login for it is saved in the vault, and that they can save it in Settings > Vault (or ask you in the chat) and run the routine again.");

/** Texto ao usuário (pt-BR) quando "Terminei" volta e a tela de login ainda está lá. */
export const loginStillShownText = (site: string) =>
	`Ainda vejo a tela de login de ${site}, então o login não parece ter sido concluído. Abra o computador, termine a entrada nesse site e me diga "pronto" que eu continuo daqui.`;
