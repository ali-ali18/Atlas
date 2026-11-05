// Escrita otimista das Configurações: a tela já mostra o valor novo e, se o servidor recusar, devolve só aquele campo
// (mudanças de campos diferentes que estejam em voo não se atropelam).
import type { SettingsChange } from "./settings-api";
import type { AccountSettings } from "./settings-parse";

export function applySettingsChange(settings: AccountSettings, change: SettingsChange): AccountSettings {
	return { ...settings, ...change };
}

/** Desfaz `change` no estado local: só o campo dela volta ao valor que `before` tinha (fuso que a conta não tinha volta a `null`). */
export function revertSettings(current: AccountSettings, before: AccountSettings, change: SettingsChange): AccountSettings {
	if ("timezone" in change) return { ...current, timezone: before.timezone };
	if ("botLanguage" in change) return { ...current, botLanguage: before.botLanguage };
	return { ...current, sandboxAutoStart: before.sandboxAutoStart };
}
