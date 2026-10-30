"use client";

import { useState } from "react";
import { ArrowUpIcon, PlusIcon, ScanSearchIcon, SignalHighIcon, SignalLowIcon, SignalMediumIcon, XIcon } from "lucide-react";
import {
	MAX_TIER_MODELS,
	type AccountConfigPatch,
	type EffectiveAccountConfig,
	type ModelTier,
	type OpenRouterModel,
} from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Switch } from "@workspace/ui/components/switch";
import { ModelPicker } from "@/components/model-picker";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import type { SettingsIcon } from "@/components/ui/templates/template-4/settings-picker";
import type { SaveStatus } from "../account-settings-state";
import {
	classifyWithReviewerPatch,
	moveTierModelUp,
	setTierModelAt,
	tierPatch,
	userTierModels,
} from "../models-state";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { modelTierLabel } from "@/lib/shared-labels";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

export const TIER_CAPTION = defaultTranslator.t("settings.tiers.caption", { max: MAX_TIER_MODELS });

export const TIER_ROWS: ReadonlyArray<{ tier: ModelTier; itemId: string; icon: SettingsIcon }> = [
	{ tier: "easy", itemId: "modelos.nivel-facil", icon: SignalLowIcon },
	{ tier: "medium", itemId: "modelos.nivel-media", icon: SignalMediumIcon },
	{ tier: "hard", itemId: "modelos.nivel-dificil", icon: SignalHighIcon },
];

const TIER_TEXT = {
	easy: { description: "settings.tiers.easy.description" },
	medium: { description: "settings.tiers.medium.description" },
	hard: { description: "settings.tiers.hard.description" },
} as const;


export const TIER_ITEM_IDS: readonly string[] = [...TIER_ROWS.map((row) => row.itemId), "modelos.classificador"];

/** Até 3 seletores compactos (principal + reservas do nível), com subir e remover; vazio herda. */
export function TierModelsControl({
	label,
	list,
	models,
	onChange,
}: {
	label: string;
	list: string[];
	models: readonly OpenRouterModel[];
	onChange: (list: string[]) => void;
}) {
	const t = useT();
	const [adding, setAdding] = useState(false);
	const showNew = adding && list.length < MAX_TIER_MODELS;
	return (
		<div className="flex w-full flex-col gap-2" data-slot="tier-models">
			{list.map((id, index) => (
				<div className="flex items-center gap-1" key={id}>
					<ModelPicker
						models={models.slice()}
						onChange={(next) => onChange(setTierModelAt(list, index, next))}
						openrouterOnly={index > 0}
						value={id}
						className="min-w-0 flex-1"
					/>
					<Button
						aria-label={t("settings.tiers.moveUpAria", { label, n: index + 1 })}
						disabled={index === 0}
						onClick={() => onChange(moveTierModelUp(list, index))}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowUpIcon aria-hidden />
					</Button>
					<Button
						aria-label={t("settings.tiers.removeAria", { label, n: index + 1 })}
						onClick={() => onChange(list.filter((_, at) => at !== index))}
						size="icon-sm"
						variant="ghost"
					>
						<XIcon aria-hidden />
					</Button>
				</div>
			))}
			{showNew ? (
				<div className="flex items-center gap-1">
					<ModelPicker
						models={models.slice()}
						onChange={(next) => {
							setAdding(false);
							onChange(setTierModelAt(list, list.length, next));
						}}
						openrouterOnly={list.length > 0}
						value=""
						className="min-w-0 flex-1"
					/>
					<Button aria-label={t("settings.tiers.cancelAria", { label })} onClick={() => setAdding(false)} size="icon-sm" variant="ghost">
						<XIcon aria-hidden />
					</Button>
				</div>
			) : null}
			<div className="flex items-center gap-2 empty:hidden">
				{list.length < MAX_TIER_MODELS && !showNew ? (
					<Button onClick={() => setAdding(true)} size="sm" variant="outline">
						<PlusIcon aria-hidden data-icon="inline-start" />
						{t("settings.models.add")}
					</Button>
				) : null}
				{list.length > 0 ? (
					<Button onClick={() => onChange([])} size="sm" variant="ghost">
						{t("settings.models.backToDefault")}
					</Button>
				) : null}
			</div>
		</div>
	);
}

/** Linha de um nível: rótulo e legenda em cima, os modelos embaixo em largura total (cabem 3 seletores no celular). */
export function TierRow({
	row,
	caption,
	children,
}: {
	row: (typeof TIER_ROWS)[number];
	caption?: string | null;
	children: React.ReactNode;
}) {
	const translator = useTranslations();
	const { t } = translator;
	return (
		<div data-slot="tier-row">
			<SettingRow
				caption={caption ? <p>{caption}</p> : null}
				description={t(TIER_TEXT[row.tier].description)}
				icon={row.icon}
				label={modelTierLabel(row.tier, translator)}
			/>
			<div className="-mt-1 px-3.5 pb-2.5">{children}</div>
		</div>
	);
}

/** Conta: "Modelos por dificuldade" (Fácil, Média, Difícil) e o switch do revisor. */
export function ModelTiersSettingsView({
	effective,
	models,
	status,
	saveError,
	loadError,
	onChange,
	isVisible = () => true,
	title,
	showStatus = true,
}: {
	title?: string;
	showStatus?: boolean;
	/** `null` enquanto carrega. */
	effective: EffectiveAccountConfig | null;
	models: readonly OpenRouterModel[];
	status: SaveStatus;
	saveError?: string | null;
	loadError?: string | null;
	onChange: (patch: AccountConfigPatch) => void;
	isVisible?: (itemId: string) => boolean;
}) {
	const translator = useTranslations();
	const { t } = translator;
	return (
		<SettingsGroup title={title}>
			{TIER_ROWS.some((row) => isVisible(row.itemId)) ? (
				<p className="px-3.5 py-1 text-xs text-muted-foreground" role="note">
					{t("settings.tiers.caption", { max: MAX_TIER_MODELS })}
				</p>
			) : null}
			{TIER_ROWS.map((row) =>
				isVisible(row.itemId) ? (
					<TierRow
						caption={effective && userTierModels(effective.models.tiers, row.tier).length === 0 ? t("settings.tiers.usesDefault") : null}
						row={row}
						key={row.tier}
					>
						{effective ? (
							<TierModelsControl
								label={modelTierLabel(row.tier, translator)}
								list={userTierModels(effective.models.tiers, row.tier)}
								models={models}
								onChange={(list) => onChange(tierPatch(row.tier, list))}
							/>
						) : (
							<p className="text-body text-muted-foreground">{t("common.loading")}</p>
						)}
					</TierRow>
				) : null,
			)}
			{isVisible("modelos.classificador") ? (
				<SettingRow
					caption={<p>{t("settings.tiers.classifier.caption")}</p>}
					control="inline"
					description={t("settings.tiers.classifier.description")}
					htmlFor="settings-model-classifier"
					icon={ScanSearchIcon}
					label={t("settings.tiers.classifier.label")}
				>
					<Switch
						checked={effective?.models.classifyWithReviewer.value ?? false}
						disabled={!effective}
						id="settings-model-classifier"
						onCheckedChange={(checked) => onChange(classifyWithReviewerPatch(checked))}
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
	);
}

export function ModelTiersSettings({
	account,
	isVisible,
	title,
	showStatus,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible?: (itemId: string) => boolean;
	title?: string;
	showStatus?: boolean;
}) {
	const { models } = useOpenRouterModels();
	return (
		<ModelTiersSettingsView
			effective={account.view?.effective ?? null}
			isVisible={isVisible}
			loadError={account.loadError}
			models={models}
			onChange={(patch) => void account.save(patch)}
			saveError={account.saveError}
			showStatus={showStatus}
			status={account.status}
			title={title}
		/>
	);
}
