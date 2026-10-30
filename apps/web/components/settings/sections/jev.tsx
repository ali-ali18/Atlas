"use client";

import {
	CheckCheckIcon,
	ChevronDownIcon,
	CornerDownRightIcon,
	EyeIcon,
	BrainIcon,
	ListChecksIcon,
	PowerOffIcon,
	RefreshCcwIcon,
	ShieldAlertIcon,
	ShieldBanIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	TargetIcon,
	UsersIcon,
	WorkflowIcon,
	ZapIcon,
} from "lucide-react";
import type {
	AccountConfigPatch,
	AccountConfigV1,
	EffectiveAccountConfig,
	JevFeature,
} from "@workspace/shared";
import {
	SettingsPicker,
	type SettingsIcon,
	withOptionIcons,
} from "@/components/ui/templates/template-4/settings-picker";
import type { OpenRouterModel } from "@workspace/shared";
import { ModelPicker } from "@/components/model-picker";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { modelPatch, modelPickerValue, reviewerInheritLabel } from "../models-state";
import type { SaveStatus } from "../account-settings-state";
import {
	jevFeatureSpecs,
	jevFeatureChoice,
	jevFeatureOptions,
	jevFeaturePatch,
	jevGeneralChoice,
	jevGeneralOptions,
	jevGeneralPatch,
	jevMcpChoice,
	jevMcpOptions,
	jevMcpPatch,
	groupsJevPatch,
} from "../jev-execution-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { SaveIndicator, SettingRow, SettingsGroup, SettingsStack } from "../setting-row";
import { SwitchRow } from "./execution";

const FEATURE_ICONS: Record<JevFeature, SettingsIcon> = {
	intent: TargetIcon,
	tools: ListChecksIcon,
	verify: CheckCheckIcon,
	blockpage: ShieldAlertIcon,
	delegate: UsersIcon,
	stuck: RefreshCcwIcon,
	memory: BrainIcon,
};

const MODE_ICONS = { inherit: CornerDownRightIcon, off: PowerOffIcon, shadow: EyeIcon, on: ZapIcon };
const MCP_MODE_ICONS = { inherit: CornerDownRightIcon, off: PowerOffIcon, shadow: EyeIcon, gate: ShieldBanIcon };


/**
 * Revisão automática (JEV): revisão de escritas em conectores, um dropdown geral para as
 * decisões auxiliares e, num segundo grupo, um dropdown por recurso.
 * Cada dropdown salva na hora; "Herdar" volta ao padrão.
 */
export function JevSettingsView({
	effective,
	config,
	openrouterKey = true,
	models = [],
	modelsLoading = false,
	status,
	saveError,
	loadError,
	onChange,
	isVisible = () => true,
	title,
	featuresTitle,
	showStatus = true,
}: {
	title?: string;
	featuresTitle?: string;
	showStatus?: boolean;
	/** `null` enquanto carrega. */
	effective: EffectiveAccountConfig | null;
	/** O que a conta gravou (decide o que é escolha própria). */
	config: AccountConfigV1 | null;
	/** Sem a chave no servidor, o Jev não tem modelo para chamar: controles desabilitados. */
	openrouterKey?: boolean;
	/** Catálogo do OpenRouter para o seletor do revisor (os de chave própria o seletor busca sozinho). */
	models?: readonly OpenRouterModel[];
	modelsLoading?: boolean;
	status: SaveStatus;
	saveError?: string | null;
	loadError?: string | null;
	onChange: (patch: AccountConfigPatch) => void;
	isVisible?: (itemId: string) => boolean;
}) {
	const translator = useTranslations();
	const { t, tn } = translator;
	const ready = effective !== null && config !== null;
	// Sem o OpenRouter no servidor o revisor ainda funciona com o modelo escolhido ou o da manutenção (chave própria).
	const disabled = !ready;
	const visibleFeatures = jevFeatureSpecs(translator).filter((spec) => isVisible(spec.itemId));

	return (
		<SettingsStack>
			{isVisible("jev.modelo") || isVisible("jev.mcp") || isVisible("jev.geral") ? (
				<SettingsGroup title={title ?? t("settings.jev.title")}>
					{ready && !openrouterKey ? (
						<p className="px-3.5 py-1 text-xs text-muted-foreground" role="note">
							{t("settings.jev.noKeyNote")}
						</p>
					) : null}

					{isVisible("jev.modelo") ? (
						<SettingRow
							caption={<p>{t("settings.jev.reviewer.caption")}</p>}
							description={t("settings.jev.reviewer.description")}
							htmlFor="settings-model-reviewer"
							icon={ShieldCheckIcon}
							label={t("settings.jev.reviewer.label")}
						>
							{effective ? (
								<ModelPicker
									emptyLabel={reviewerInheritLabel(effective, models, openrouterKey, translator) ?? t("settings.exec.inherit")}
									id="settings-model-reviewer"
									loading={modelsLoading}
									models={models.slice()}
									noChatgpt
									onChange={(id) => onChange(modelPatch("reviewer", id))}
									value={modelPickerValue(effective.models.reviewer)}
								/>
							) : (
								<p className="text-body text-muted-foreground">{t("common.loading")}</p>
							)}
						</SettingRow>
					) : null}

					{isVisible("jev.mcp") ? (
						<SettingRow
							caption={<p>{t("settings.jev.mcp.caption")}</p>}
							description={t("settings.jev.mcp.description")}
							htmlFor="settings-jev-mcp"
							icon={ShieldCheckIcon}
							label={t("settings.jev.mcp.label")}
						>
							<SettingsPicker
								disabled={disabled}
								id="settings-jev-mcp"
								onChange={(choice) => onChange(jevMcpPatch(choice))}
								options={effective ? withOptionIcons(jevMcpOptions(effective.jev.mcp, translator), MCP_MODE_ICONS) : []}
								placeholder={t("common.loading")}
								value={effective ? jevMcpChoice(effective.jev.mcp) : ""}
							/>
						</SettingRow>
					) : null}

					{isVisible("jev.geral") ? (
						<SettingRow
							caption={<p>{t("settings.jev.all.caption")}</p>}
							description={t("settings.jev.all.description")}
							htmlFor="settings-jev-all"
							icon={WorkflowIcon}
							label={t("settings.jev.all.label")}
						>
							<SettingsPicker
								disabled={disabled}
								id="settings-jev-all"
								onChange={(choice) => onChange(jevGeneralPatch(choice))}
								options={withOptionIcons(jevGeneralOptions(translator), MODE_ICONS)}
								placeholder={t("common.loading")}
								value={config ? jevGeneralChoice(config) : ""}
							/>
						</SettingRow>
					) : null}

					{showStatus ? (
						<div className="px-3.5 empty:hidden">
							{loadError ? (
								<p className="text-xs text-destructive" role="alert">
									{loadError}
								</p>
							) : (
								<SaveIndicator error={saveError} status={status} />
							)}
						</div>
					) : null}
				</SettingsGroup>
			) : null}

			{visibleFeatures.length > 0 && effective && config ? (
				<SettingsGroup>
					<Collapsible
						data-slot="jev-features"
						// Numa busca que só casou com recursos, já abre para mostrar o resultado.
						defaultOpen={!isVisible("jev.mcp") && !isVisible("jev.geral")}
					>
						<CollapsibleTrigger
							className="group/trigger flex min-h-10 w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left outline-none focus-visible:bg-accent/50"
							data-slot="jev-features-trigger"
						>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="flex items-center gap-2">
									<SlidersHorizontalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" data-slot="setting-row-icon" />
									<span className="text-body leading-[18px]">{featuresTitle ?? t("settings.jev.featuresTitle")}</span>
								</span>
								<span className="text-xs text-muted-foreground">{tn("settings.jev.featuresCount", visibleFeatures.length)}</span>
							</span>
							<ChevronDownIcon
								aria-hidden
								className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-180"
							/>
						</CollapsibleTrigger>
						<CollapsibleContent>
							{visibleFeatures.map((spec) => (
								<SettingRow
									description={spec.description}
									htmlFor={`settings-jev-${spec.feature}`}
									icon={FEATURE_ICONS[spec.feature]}
									key={spec.feature}
									label={spec.label}
								>
									<SettingsPicker
										disabled={disabled}
										id={`settings-jev-${spec.feature}`}
										onChange={(choice) => onChange(jevFeaturePatch(spec.feature, choice))}
										options={withOptionIcons(
											jevFeatureOptions(config, effective.jev.features[spec.feature], translator),
											MODE_ICONS,
										)}
										value={jevFeatureChoice(config, spec.feature)}
									/>
								</SettingRow>
							))}
						</CollapsibleContent>
					</Collapsible>
				</SettingsGroup>
			) : null}

			{!ready && !loadError ? <p className="px-2 text-body text-muted-foreground">{t("common.loading")}</p> : null}
		</SettingsStack>
	);
}

export function JevSettings({
	account,
	isVisible,
	title,
	featuresTitle,
	showStatus,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible?: (itemId: string) => boolean;
	title?: string;
	featuresTitle?: string;
	showStatus?: boolean;
}) {
	const { models, loading } = useOpenRouterModels();
	return (
		<JevSettingsView
			models={models}
			modelsLoading={loading}
			config={account.view?.config ?? null}
			effective={account.view?.effective ?? null}
			isVisible={isVisible}
			loadError={account.loadError}
			onChange={(patch) => void account.save(patch)}
			openrouterKey={account.view?.capabilities.openrouterKey ?? true}
			saveError={account.saveError}
			showStatus={showStatus}
			status={account.status}
			title={title}
			featuresTitle={featuresTitle}
		/>
	);
}

/** Linha "Grupos: coordenação inteligente" (mora em Geral): liga o Jev como coordenador em grupos de bots. */
export function GroupsCoordinationRow({
	account,
	isVisible = () => true,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible?: (itemId: string) => boolean;
}) {
	const t = useT();
	if (!isVisible("jev.grupos")) return null;
	const effective = account.view?.effective ?? null;
	return (
		<SwitchRow
			description={t("settings.jev.groups.description")}
			icon={UsersIcon}
			id="settings-jev-groups"
			label={t("settings.jev.groups.label")}
			onChange={(checked) => void account.save(groupsJevPatch(checked))}
			onInherit={() => void account.save({ groups: { jevCoordination: null } })}
			resolved={effective?.groups?.jevCoordination ?? null}
		/>
	);
}
