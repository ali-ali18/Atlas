import type { ConfigSource, ProviderStatus, Resolved } from "@workspace/shared";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/** Mensagem do código de erro de login (os textos de `shared` são só pt-BR); `null` = código desconhecido. */
export function providerLoginError(code: string | null | undefined, { t }: Translator = defaultTranslator): string | null {
	if (!code) return null;
	if (code === "invalid_token_response:scope_missing_plan") return t("settings.providers.err.scopeMissingPlan");
	if (code.startsWith("invalid_token_response:"))
		return t("settings.providers.err.invalidTokenResponseWith", { detail: code.slice("invalid_token_response:".length) });
	if (code === "invalid_token_response") return t("settings.providers.err.invalidTokenResponse");
	if (code === "device_expired") return t("settings.providers.err.deviceExpired");
	if (code === "device_failed" || code === "device_invalid_response") return t("settings.providers.err.deviceFailed");
	if (code === "invalid_id_token") return t("settings.providers.err.invalidIdToken");
	return null;
}

export function providerConnectionLabel(status: ProviderStatus | null, error?: string | null, translator: Translator = defaultTranslator) {
	const { t } = translator;
	if (error || status?.status === "error") return t("settings.providers.unavailable");
	if (status?.status === "connected")
		return status.accountEmail ? t("settings.providers.connectedAs", { email: status.accountEmail }) : t("settings.providers.connected");
	if (status?.status === "needs_login")
		return providerLoginError(status.lastError, translator) ?? t("settings.providers.reconnect");
	return t("settings.providers.notConnected");
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
export function chatgptSwitchHint(enabled: Resolved<boolean>, { t }: Translator = defaultTranslator): string {
	if (enabled.source === "user") return t("settings.providers.hintUser");
	const value = enabled.value ? t("settings.providers.on") : t("settings.providers.off");
	return enabled.source === "env"
		? t("settings.providers.hintServer", { value })
		: t("settings.providers.hintAccount", { value });
}

/** Desconectar da conta continua possível com o plano desligado por você (a API permite). */
export function canDisconnect(state: ProvidersViewState, source: ConfigSource | undefined): boolean {
	return state === "connected" || state === "needs_login" || state === "error" || (state === "off" && source === "user");
}
