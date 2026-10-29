"use client";

import { LanguagesIcon, MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { BotLanguageSetting, Resolved } from "@workspace/shared";
import {
	SettingsPicker,
	type SettingsPickerOption,
	withOptionIcons,
} from "@/components/ui/templates/template-4/settings-picker";
import { BOT_LANGUAGE_AUTO_LABEL, BOT_LANGUAGE_SETTING_OPTIONS } from "@/lib/bot-language";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { type SaveStatus, inheritLabel } from "../account-settings-state";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";

export type ThemeChoice = "light" | "dark" | "system";

const THEME_OPTIONS: readonly SettingsPickerOption<ThemeChoice>[] = withOptionIcons(
	[
		{ value: "light", label: "Claro" },
		{ value: "dark", label: "Escuro" },
		{ value: "system", label: "Sistema" },
	],
	{ light: SunIcon, dark: MoonIcon, system: MonitorIcon },
);

const INHERIT = "inherit";
type LanguageChoice = BotLanguageSetting | typeof INHERIT;

/** Opções do idioma: "Herdar" (com a origem do valor) + os idiomas dos bots. */
export function languageOptions(
	language: Resolved<BotLanguageSetting>,
): SettingsPickerOption<LanguageChoice>[] {
	const inherit = inheritLabel(language.source, language.value === "auto" ? BOT_LANGUAGE_AUTO_LABEL : language.value) ?? "Herdar do servidor";
	return [
		{ value: INHERIT, label: inherit },
		...BOT_LANGUAGE_SETTING_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
	];
}

/** Tela Geral: tema (neste navegador) e idioma padrão de bots novos (da conta). */
export function GeneralSettingsView({
	theme,
	onThemeChange,
	language,
	onLanguageChange,
	status,
	saveError,
	loadError,
	isVisible = () => true,
}: {
	theme: ThemeChoice;
	onThemeChange: (theme: ThemeChoice) => void;
	/** `null` enquanto carrega. */
	language: Resolved<BotLanguageSetting> | null;
	/** `null` = voltar a herdar. */
	onLanguageChange: (language: BotLanguageSetting | null) => void;
	status: SaveStatus;
	saveError?: string | null;
	loadError?: string | null;
	isVisible?: (itemId: string) => boolean;
}) {
	return (
		<SettingsGroup title="Aparência">
			{isVisible("geral.tema") ? (
				<SettingRow
					description="Vale só para este navegador."
					htmlFor="settings-theme"
					icon={PaletteIcon}
					label="Tema"
				>
					<SettingsPicker
						id="settings-theme"
						onChange={onThemeChange}
						options={THEME_OPTIONS}
						value={theme}
					/>
				</SettingRow>
			) : null}

			{isVisible("geral.idioma") ? (
				<SettingRow
					caption={
						loadError ? (
							<p className="text-xs text-destructive" role="alert">
								{loadError}
							</p>
						) : (
							<SaveIndicator error={saveError} status={status} />
						)
					}
					description="Idioma que os novos bots usam ao serem criados. Cada bot pode mudar o seu."
					htmlFor="settings-default-language"
					icon={LanguagesIcon}
					label="Idioma dos bots novos"
				>
					<SettingsPicker
						disabled={!language}
						id="settings-default-language"
						onChange={(choice) => onLanguageChange(choice === INHERIT ? null : choice)}
						options={language ? languageOptions(language) : []}
						placeholder="Carregando…"
						value={language ? (language.source === "user" ? language.value : INHERIT) : ""}
					/>
				</SettingRow>
			) : null}
		</SettingsGroup>
	);
}

export function GeneralSettings({
	account,
	isVisible,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible: (itemId: string) => boolean;
}) {
	const { theme, setTheme } = useTheme();
	const current: ThemeChoice = theme === "light" || theme === "dark" ? theme : "system";
	return (
		<GeneralSettingsView
			isVisible={isVisible}
			language={account.view?.effective.general.defaultBotLanguage ?? null}
			loadError={account.loadError}
			onLanguageChange={(language) =>
				void account.save({ general: { defaultBotLanguage: language } })
			}
			onThemeChange={setTheme}
			saveError={account.saveError}
			status={account.status}
			theme={current}
		/>
	);
}
