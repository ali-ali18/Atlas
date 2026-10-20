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
import { modelPatch, modelPickerValue, reviewerInheritLabel } from "../models-state";
import type { SaveStatus } from "../account-settings-state";
import {
	JEV_FEATURE_SPECS,
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

export const NO_OPENROUTER_KEY_NOTE = "Chave do OpenRouter não configurada no servidor";
export const REVIEWER_CAPTION = "Modelo que revisa os runs, detecta travamentos e classifica pedidos. Use um modelo rápido.";

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
	title = "Revisões gerais",
	featuresTitle = "Ajustar por recurso",
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
	const ready = effective !== null && config !== null;
	// Sem o OpenRouter no servidor o revisor ainda funciona com o modelo escolhido ou o da manutenção (chave própria).
	const disabled = !ready;
	const visibleFeatures = JEV_FEATURE_SPECS.filter((spec) => isVisible(spec.itemId));

	return (
		<SettingsStack>
			{isVisible("jev.modelo") || isVisible("jev.mcp") || isVisible("jev.geral") ? (
				<SettingsGroup title={title}>
					{ready && !openrouterKey ? (
						<p className="px-3.5 py-1 text-xs text-muted-foreground" role="note">
							{NO_OPENROUTER_KEY_NOTE}: o revisor usa o modelo escolhido abaixo ou o de manutenção, com a chave de um provedor conectado.
						</p>
					) : null}

					{isVisible("jev.modelo") ? (
						<SettingRow
							caption={<p>{REVIEWER_CAPTION}</p>}
							description="Qualquer provedor com chave (OpenRouter, Anthropic, OpenCode Go); o plano ChatGPT não vale. Vazio usa o Jev no OpenRouter."
							htmlFor="settings-model-reviewer"
							icon={ShieldCheckIcon}
							label="Modelo do revisor"
						>
							{effective ? (
								<ModelPicker
									emptyLabel={reviewerInheritLabel(effective, models, openrouterKey) ?? "Herdar"}
									id="settings-model-reviewer"
									loading={modelsLoading}
									models={models.slice()}
									noChatgpt
									onChange={(id) => onChange(modelPatch("reviewer", id))}
									value={modelPickerValue(effective.models.reviewer)}
								/>
							) : (
								<p className="text-[13px] text-muted-foreground">Carregando…</p>
							)}
						</SettingRow>
					) : null}

					{isVisible("jev.mcp") ? (
						<SettingRow
							caption={<p>Confere antes de criar, editar ou apagar algo num conector.</p>}
							description="Antes de uma escrita num conector (criar, editar, apagar), a revisão confere se ela faz sentido."
							htmlFor="settings-jev-mcp"
							icon={ShieldCheckIcon}
							label="Revisão de escritas em conectores"
						>
							<SettingsPicker
								disabled={disabled}
								id="settings-jev-mcp"
								onChange={(choice) => onChange(jevMcpPatch(choice))}
								options={effective ? withOptionIcons(jevMcpOptions(effective.jev.mcp), MCP_MODE_ICONS) : []}
								placeholder="Carregando…"
								value={effective ? jevMcpChoice(effective.jev.mcp) : ""}
							/>
						</SettingRow>
					) : null}

					{isVisible("jev.geral") ? (
						<SettingRow
							caption={<p>Checagens extras enquanto o bot trabalha. Mais cuidado, um pouco mais de espera.</p>}
							description="Decisões extras do Jev durante o run. Observar registra sem agir. Cada uma é uma chamada leve ao modelo, mas soma tempo de espera."
							htmlFor="settings-jev-all"
							icon={WorkflowIcon}
							label="Decisões auxiliares"
						>
							<SettingsPicker
								disabled={disabled}
								id="settings-jev-all"
								onChange={(choice) => onChange(jevGeneralPatch(choice))}
								options={withOptionIcons(jevGeneralOptions(), MODE_ICONS)}
								placeholder="Carregando…"
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
									<span className="text-[13px] leading-[18px]">{featuresTitle}</span>
								</span>
								<span className="text-xs text-muted-foreground">{visibleFeatures.length} ajustes finos, um por recurso</span>
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
											jevFeatureOptions(config, effective.jev.features[spec.feature]),
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

			{!ready && !loadError ? <p className="px-2 text-[13px] text-muted-foreground">Carregando…</p> : null}
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
	if (!isVisible("jev.grupos")) return null;
	const effective = account.view?.effective ?? null;
	return (
		<SwitchRow
			description="Em grupos de bots, o Jev escolhe quem responde e, quando o pedido envolve vários bots, um coordena: divide o trabalho, confere as entregas e resume no fim. Desligado, vale a escolha de sempre."
			icon={UsersIcon}
			id="settings-jev-groups"
			label="Grupos: coordenação inteligente"
			onChange={(checked) => void account.save(groupsJevPatch(checked))}
			onInherit={() => void account.save({ groups: { jevCoordination: null } })}
			resolved={effective?.groups?.jevCoordination ?? null}
		/>
	);
}
