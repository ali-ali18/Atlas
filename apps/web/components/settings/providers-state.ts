import { providerErrorMessage, type ConfigSource, type ProviderStatus, type Resolved } from "@workspace/shared";

export function providerConnectionLabel(status: ProviderStatus | null, error?: string | null) {
	if (error || status?.status === "error") return "ChatGPT temporariamente indisponível";
	if (status?.status === "connected")
		return `Conectado${status.accountEmail ? ` como ${status.accountEmail}` : ""}`;
	if (status?.status === "needs_login")
		return providerErrorMessage(status.lastError) ?? "Reconecte o ChatGPT";
	return "Não conectado";
}

/**
 * Estado da tela Provedores:
 * - `loading`: ainda sem a resposta de `GET /v1/settings`;
 * - `hidden`: não é o dono (o plano ChatGPT é só do dono);
 * - `off`: plano desligado (a conexão e os tokens, se houver, ficam guardados);
 * - `disconnected` / `needs_login` / `connected` / `error`: plano ligado, por situação da conexão.
 */
export type ProvidersViewState =
	| "loading"
	| "hidden"
	| "off"
	| "disconnected"
	| "needs_login"
	| "connected"
	| "error";

export function providersViewState(input: {
	enabled: Resolved<boolean> | null;
	isOwner: boolean | null;
	status: ProviderStatus | null;
	error?: string | null;
}): ProvidersViewState {
	if (input.isOwner === false) return "hidden";
	if (!input.enabled || input.isOwner === null) return "loading";
	if (!input.enabled.value) return "off";
	if (input.error || input.status?.status === "error") return "error";
	if (input.status?.status === "connected") return "connected";
	return input.status?.status === "needs_login" ? "needs_login" : "disconnected";
}

/** Linha de apoio do switch: de onde vem o valor quando o usuário não definiu. */
export function chatgptSwitchHint(enabled: Resolved<boolean>): string {
	if (enabled.source === "user") return "Definido por você.";
	const value = enabled.value ? "ligado" : "desligado";
	return enabled.source === "env"
		? `Herdado do padrão do servidor (${value}).`
		: `Herdado do padrão da conta (${value}).`;
}

/** Desconectar da conta continua possível com o plano desligado por você (a API permite). */
export function canDisconnect(state: ProvidersViewState, source: ConfigSource | undefined): boolean {
	return state === "connected" || state === "needs_login" || state === "error" || (state === "off" && source === "user");
}
