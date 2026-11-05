// Configurações no servidor: os mesmos endpoints do web (`/v1/settings`, `/v1/autonomy`, `/v1/usage`, `/v1/me`), sempre por
// `apiFetch` (a sessão sai só para o servidor salvo). O dono vem da sessão; o app nunca manda `userId`. Parse em
// `settings-parse.ts`; erro sobe como `ChatApiError` (a tela mostra `friendlyError`).
import type { AutonomyLevel, BotLanguageSetting, UsagePeriod } from "@workspace/shared";
import { ChatApiError, json } from "./chat-api";
import type { ApiFetch } from "./home-sync";
import { type AccountSettings, parseAccountSettings, parseAutonomyLevel, parseUsage, type UsageView } from "./settings-parse";

const unexpected = () => new ChatApiError("Resposta inesperada do servidor.", 502);

export async function fetchAccountSettings(apiFetch: ApiFetch): Promise<AccountSettings> {
	const settings = parseAccountSettings(await json<unknown>(apiFetch, "/v1/settings"));
	if (!settings) throw unexpected();
	return settings;
}

/** Corpo do `PATCH /v1/settings` para cada campo editável (fuso e idioma vão em `config.general`). */
export type SettingsChange = { timezone: string } | { botLanguage: BotLanguageSetting } | { sandboxAutoStart: boolean };

export function settingsPatchBody(change: SettingsChange): Record<string, unknown> {
	if ("timezone" in change) return { config: { general: { timezone: change.timezone } } };
	if ("botLanguage" in change) return { config: { general: { defaultBotLanguage: change.botLanguage } } };
	return { sandboxAutoStart: change.sandboxAutoStart };
}

/** Grava uma mudança e devolve a conta como o servidor ficou (a tela reconcilia com isto). */
export async function saveAccountSetting(apiFetch: ApiFetch, change: SettingsChange): Promise<AccountSettings> {
	const settings = parseAccountSettings(await json<unknown>(apiFetch, "/v1/settings", { method: "PATCH", body: JSON.stringify(settingsPatchBody(change)) }));
	if (!settings) throw unexpected();
	return settings;
}

export async function fetchAutonomyLevel(apiFetch: ApiFetch): Promise<AutonomyLevel> {
	const level = parseAutonomyLevel(await json<unknown>(apiFetch, "/v1/autonomy"));
	if (!level) throw unexpected();
	return level;
}

/** Troca o nível de permissão da conta (sem prazo: vale até mudar). */
export async function saveAutonomyLevel(apiFetch: ApiFetch, level: AutonomyLevel): Promise<AutonomyLevel> {
	const saved = parseAutonomyLevel(await json<unknown>(apiFetch, "/v1/autonomy", { method: "PUT", body: JSON.stringify({ level, duration: "forever" }) }));
	if (!saved) throw unexpected();
	return saved;
}

/** Uso do período; `tz` é o fuso do dia civil (o do aparelho ou da conta). */
export async function fetchUsage(apiFetch: ApiFetch, period: UsagePeriod, tz: string): Promise<UsageView> {
	const usage = parseUsage(await json<unknown>(apiFetch, `/v1/usage?period=${encodeURIComponent(period)}&tz=${encodeURIComponent(tz)}`));
	if (!usage) throw unexpected();
	return usage;
}

/** Troca o nome (o servidor valida: 1 a 60 caracteres). */
export async function saveProfileName(apiFetch: ApiFetch, name: string): Promise<void> {
	await json<unknown>(apiFetch, "/v1/me", { method: "PATCH", body: JSON.stringify({ name }) });
}

/** Troca a foto: `image` é um data URL (WebP, JPEG ou PNG) de até 120 KB; o servidor reduz e guarda. */
export async function saveProfileImage(apiFetch: ApiFetch, image: string): Promise<void> {
	await json<unknown>(apiFetch, "/v1/me/image", { method: "PUT", body: JSON.stringify({ image }) });
}

export async function removeProfileImage(apiFetch: ApiFetch): Promise<void> {
	await json<unknown>(apiFetch, "/v1/me/image", { method: "DELETE" });
}
