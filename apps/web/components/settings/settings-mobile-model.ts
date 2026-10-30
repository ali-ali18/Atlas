import { formatNumber } from "@/lib/format";
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { SETTINGS_NAV, navGroupLabel, navSectionLabel, type SettingsNavId } from "./settings-registry";

/** Modelo puro da lista mobile: grupos de linhas, cada uma levando a uma seção. */
export type MobileSettingsRow = { id: SettingsNavId; title: string; secondary: string };
export type MobileSettingsGroup = { id: string; label: string; rows: MobileSettingsRow[] };

export type MobileSettingsSummary = {
	theme?: string;
	defaultModel?: string;
	chatgptEnabled?: boolean;
	/** Navegador do agente liga sozinho (`sandboxAutoStart`); `undefined` = ainda carregando. */
	browserAuto?: boolean;
	/** Conexões ativas (Composio + MCP); `undefined` = ainda carregando. */
	connectionsCount?: number;
	/** Ambientes de código salvos; `undefined` = ainda carregando. */
	environmentsCount?: number;
	/** Habilidades da conta; `undefined` = ainda carregando. */
	skillsCount?: number;
	/** Custo do período em US$; `null` = sem custo informado; `undefined` = carregando. */
	usageCostUsd?: number | null;
	/** Revisão (JEV): `on` se algum recurso está ligado, `shadow` se só em teste. */
	reviewMode?: "off" | "shadow" | "on";
};

const brl = (value: number, digits: number, locale: UiLocale) =>
	formatNumber(value, locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function connectionsHint(count: number | undefined, { t, tn } = defaultTranslator): string {
	if (count === undefined) return t("settings.mobile.connectionsUnknown");
	return count === 0 ? t("settings.mobile.connectionsNone") : tn("settings.mobile.connections", count);
}

export function skillsHint(count: number | undefined, { t, tn } = defaultTranslator): string {
	if (count === undefined) return t("settings.mobile.skillsUnknown");
	return count === 0 ? t("settings.mobile.skillsNone") : tn("settings.mobile.skills", count);
}

/** Computador: navegador do agente e, se houver, quantos ambientes de código. */
export function computerHint(browserAuto: boolean | undefined, environments: number | undefined, { t, tn } = defaultTranslator): string {
	const envs = environments ? tn("settings.mobile.environments", environments) : null;
	if (!envs) {
		if (browserAuto === undefined) return t("settings.mobile.computerDefault");
		return browserAuto ? t("settings.mobile.browserAuto") : t("settings.mobile.browserManual");
	}
	const browser = browserAuto === undefined ? t("settings.mobile.browser") : browserAuto ? t("settings.mobile.auto") : t("settings.mobile.manual");
	return `${browser} · ${envs}`;
}

export function usageHint(cost: number | null | undefined, locale: UiLocale = DEFAULT_UI_LOCALE, { t } = defaultTranslator): string {
	if (cost === undefined || cost === null) return t("settings.mobile.usageUnknown");
	const text = cost > 0 && cost < 0.01 ? brl(cost, 4, locale) : brl(cost, 2, locale);
	return t("settings.mobile.usageCost", { cost: text });
}

export function reviewHint(mode: MobileSettingsSummary["reviewMode"], { t } = defaultTranslator): string {
	if (mode === "on") return t("settings.mobile.reviewOn");
	if (mode === "shadow") return t("settings.mobile.reviewShadow");
	if (mode === "off") return t("settings.mobile.reviewOff");
	return t("settings.mobile.reviewDefault");
}

/** Título de cada página no mobile em pt-BR (a tela usa `navSectionLabel` com o idioma ativo). */
export const MOBILE_TITLES = Object.fromEntries(
	SETTINGS_NAV.map((entry) => [entry.id, navSectionLabel(defaultTranslator.t, entry.id)]),
) as Record<SettingsNavId, string>;

/** As mesmas seções do desktop (Conta fica no cartão de perfil do topo); Revisão e Diagnóstico ficam por último. */
export function mobileSettingsGroups(
	summary: MobileSettingsSummary,
	hidden: ReadonlySet<SettingsNavId> = new Set(),
	translator: Translator = defaultTranslator,
): MobileSettingsGroup[] {
	const { t } = translator;
	const row = (id: SettingsNavId, secondary: string): MobileSettingsRow => ({
		id,
		title: navSectionLabel(t, id),
		secondary,
	});
	const geralHint = summary.theme ? t("settings.mobile.theme", { theme: summary.theme.toLowerCase() }) : t("settings.mobile.generalDefault");
	const modelosHint = summary.defaultModel ?? t("settings.mobile.modelsDefault");
	const provedoresHint = summary.chatgptEnabled ? t("settings.mobile.chatgptOn") : t("settings.mobile.providersDefault");
	const groups: MobileSettingsGroup[] = [
		{
			id: "basico",
			label: navGroupLabel(t, "basico"),
			rows: [row("geral", geralHint), row("notificacoes", t("settings.mobile.notifications"))],
		},
		{
			id: "inteligencia",
			label: navGroupLabel(t, "inteligencia"),
			rows: [
				row("bots", t("settings.mobile.bots")),
				row("modelos", modelosHint),
				row("provedores", provedoresHint),
			],
		},
		{
			id: "ambiente",
			label: navGroupLabel(t, "ambiente"),
			rows: [
				row("computador", computerHint(summary.browserAuto, summary.environmentsCount, translator)),
				row("conexoes", connectionsHint(summary.connectionsCount, translator)),
				row("cofre", t("settings.mobile.vault")),
				row("habilidades", skillsHint(summary.skillsCount, translator)),
			],
		},
		{
			id: "controle",
			label: navGroupLabel(t, "controle"),
			rows: [
				row("uso", usageHint(summary.usageCostUsd, translator.locale, translator)),
				row("execucao", t("settings.mobile.execution")),
				row("revisao", reviewHint(summary.reviewMode, translator)),
				row("diagnostico", t("settings.mobile.diagnostics")),
			],
		},
	];
	return groups
		.map((group) => ({ ...group, rows: group.rows.filter((r) => !hidden.has(r.id)) }))
		.filter((group) => group.rows.length > 0);
}
