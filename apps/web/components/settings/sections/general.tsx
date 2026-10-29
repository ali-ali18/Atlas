"use client";

import { GlobeIcon, LanguagesIcon, MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { BotLanguageSetting, Resolved } from "@workspace/shared";
import {
	SettingsPicker,
	type SettingsPickerOption,
	withOptionIcons,
} from "@/components/ui/templates/template-4/settings-picker";
import { botLanguageSettingOptions } from "@/lib/bot-language";
import { UI_LOCALES, UI_LOCALE_LABELS, type UiLocalePreference } from "@/lib/i18n/locales";
import { useTranslations, useUiLocalePreference } from "@/lib/i18n/provider";
import { writeUiLocalePreference } from "@/lib/i18n/preference";
import { defaultTranslator, type TFunction } from "@/lib/i18n/translator";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { type SaveStatus, inheritLabel } from "../account-settings-state";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";

export type ThemeChoice = "light" | "dark" | "system";

function themeOptions(t: TFunction): readonly SettingsPickerOption<ThemeChoice>[] {
	return withOptionIcons(
		[
			{ value: "light", label: t("settings.general.themeLight") },
			{ value: "dark", label: t("settings.general.themeDark") },
			{ value: "system", label: t("settings.general.themeSystem") },
		],
		{ light: SunIcon, dark: MoonIcon, system: MonitorIcon },
	);
}

/** Opções do idioma da interface: "Automático" + cada idioma escrito nele mesmo. */
export function uiLocaleOptions(t: TFunction = defaultTranslator.t): SettingsPickerOption<UiLocalePreference>[] {
	return [
		{ value: "auto", label: t("common.auto") },
		...UI_LOCALES.map((locale) => ({ value: locale, label: UI_LOCALE_LABELS[locale] })),
	];
}

const INHERIT = "inherit";
type LanguageChoice = BotLanguageSetting | typeof INHERIT;

/** Opções do idioma: "Herdar" (com a origem do valor) + os idiomas dos bots. */
export function languageOptions(
	language: Resolved<BotLanguageSetting>,
	t: TFunction = defaultTranslator.t,
): SettingsPickerOption<LanguageChoice>[] {
	const inherit = inheritLabel(language.source, language.value === "auto" ? t("common.auto") : language.value, t) ?? t("settings.general.inheritServer");
	return [
		{ value: INHERIT, label: inherit },
		...botLanguageSettingOptions(t("common.auto")).map((option) => ({ value: option.id, label: option.label })),
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
	uiLocale = "auto",
	onUiLocaleChange = () => {},
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
	/** Escolha do idioma da interface (por navegador, não é da conta). */
	uiLocale?: UiLocalePreference;
	onUiLocaleChange?: (preference: UiLocalePreference) => void;
}) {
	const { t } = useTranslations();
	return (
		<SettingsGroup title={t("settings.general.appearance")}>
			{isVisible("geral.tema") ? (
				<SettingRow
					description={t("settings.general.themeHint")}
					htmlFor="settings-theme"
					icon={PaletteIcon}
					label={t("settings.general.theme")}
				>
					<SettingsPicker
						id="settings-theme"
						onChange={onThemeChange}
						options={themeOptions(t)}
						value={theme}
					/>
				</SettingRow>
			) : null}

			{isVisible("geral.idioma-interface") ? (
				<SettingRow
					description={t("settings.general.uiLanguageHint")}
					htmlFor="settings-ui-language"
					icon={GlobeIcon}
					label={t("settings.general.uiLanguage")}
				>
					<SettingsPicker
						id="settings-ui-language"
						onChange={onUiLocaleChange}
						options={uiLocaleOptions(t)}
						value={uiLocale}
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
					description={t("settings.general.botLanguageHint")}
					htmlFor="settings-default-language"
					icon={LanguagesIcon}
					label={t("settings.general.botLanguage")}
				>
					<SettingsPicker
						disabled={!language}
						id="settings-default-language"
						onChange={(choice) => onLanguageChange(choice === INHERIT ? null : choice)}
						options={language ? languageOptions(language, t) : []}
						placeholder={t("common.loading")}
						value={language ? (language.source === "user" ? language.value : INHERIT) : ""}
					/>
				</SettingRow>
			) : null}
		</SettingsGroup>
	);
}

/**
 * Grava a escolha (cookie) e recarrega a página: o idioma vem do servidor (layout) e várias telas guardam
 * texto já montado no estado, então recarregar é o jeito simples de a interface inteira trocar de uma vez.
 */
function changeUiLocale(preference: UiLocalePreference) {
	writeUiLocalePreference(preference);
	window.location.reload();
}

export function GeneralSettings({
	account,
	isVisible,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible: (itemId: string) => boolean;
}) {
	const { theme, setTheme } = useTheme();
	const preference = useUiLocalePreference();
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
			onUiLocaleChange={changeUiLocale}
			saveError={account.saveError}
			status={account.status}
			theme={current}
			uiLocale={preference}
		/>
	);
}
