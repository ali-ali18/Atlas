"use client";

import { useState } from "react";
import { BotIcon, CodeIcon, EyeIcon, ImageIcon, LayersIcon, MicIcon, PlusIcon, WrenchIcon, XIcon } from "lucide-react";
import {
	MAX_FALLBACK_MODELS,
	type AccountConfigPatch,
	type EffectiveAccountConfig,
	type OpenRouterModel,
	type TranscriptionModelsResponse,
} from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ModelCapabilityWarning } from "@workspace/ui/components/model-capability-badges";
import { ModelPicker } from "@/components/model-picker";
import { useOpenRouterImageModels, useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { useTranscriptionModels } from "@/hooks/use-transcription-models";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import type { SettingsIcon } from "@/components/ui/templates/template-4/settings-picker";
import type { SaveStatus } from "../account-settings-state";
import {
	type ModelSetting,
	MODEL_SETTING_NO_CHATGPT,
	MODEL_SETTING_OPENROUTER_ONLY,
	maintenanceInheritLabel,
	dictationDefaultLabel,
	fallbacksInheritLabel,
	fallbacksPatch,
	modelInheritLabel,
	modelPatch,
	modelPickerValue,
	modelSettingWarning,
	modelsForSetting,
	removeFallbackAt,
	setFallbackAt,
	transcriptionPickerModels,
	userFallbacks,
} from "../models-state";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";
import { useT, useTranslations } from "@/lib/i18n/provider";

type ModelRowSpec = {
	setting: Exclude<ModelSetting, "reviewer" | "stt">;
	itemId: string;
	icon: SettingsIcon;
};

/** Os textos de cada linha (rótulo, descrição, "Herdar (…)" vazio) vêm do dicionário: `settings.models.<setting>.*`. */
const MODEL_ROWS: readonly ModelRowSpec[] = [
	{ setting: "default", itemId: "modelos.padrao", icon: BotIcon },
	{ setting: "coding", itemId: "modelos.codigo", icon: CodeIcon },
	{ setting: "maintenance", itemId: "modelos.manutencao", icon: WrenchIcon },
	{ setting: "vision", itemId: "modelos.visao", icon: EyeIcon },
	{ setting: "image", itemId: "modelos.imagem", icon: ImageIcon },
];

const ROW_TEXT = {
	default: { label: "settings.models.default.label", description: "settings.models.default.description", empty: "settings.models.default.empty" },
	coding: { label: "settings.models.coding.label", description: "settings.models.coding.description", empty: "settings.models.coding.empty" },
	maintenance: { label: "settings.models.maintenance.label", description: "settings.models.maintenance.description", empty: "settings.models.maintenance.empty" },
	vision: { label: "settings.models.vision.label", description: "settings.models.vision.description", empty: "settings.models.vision.empty" },
	image: { label: "settings.models.image.label", description: "settings.models.image.description", empty: "settings.models.image.empty" },
} as const;

export function ModelsSettingsView({
	effective,
	models,
	imageModels = [],
	modelsLoading = false,
	openrouterKey = true,
	dictation = null,
	dictationLoading = false,
	status,
	saveError,
	loadError,
	onChange,
	isVisible = () => true,
	title,
	showStatus = true,
	showKeyNote = true,
}: {
	/** Título do grupo; sem título (dentro de outro grupo) só as linhas aparecem. */
	title?: string;
	/** "Salvo"/erro no fim do grupo (só um dos grupos da tela precisa mostrar). */
	showStatus?: boolean;
	showKeyNote?: boolean;
	/** `null` enquanto carrega. */
	effective: EffectiveAccountConfig | null;
	models: readonly OpenRouterModel[];
	/** Catálogo de modelos que geram imagem; vazio = filtra a lista de chat. */
	imageModels?: readonly OpenRouterModel[];
	modelsLoading?: boolean;
	openrouterKey?: boolean;
	/** Modelos de ditado do servidor; `null` = sem STT no servidor (a configuração some). */
	dictation?: TranscriptionModelsResponse | null;
	dictationLoading?: boolean;
	status: SaveStatus;
	saveError?: string | null;
	loadError?: string | null;
	onChange: (patch: AccountConfigPatch) => void;
	isVisible?: (itemId: string) => boolean;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const fallbackList = effective ? userFallbacks(effective.models.fallbacks) : [];
	const dictationModels = dictation ? transcriptionPickerModels(dictation.models) : [];
	const fallbackInherit = effective ? fallbacksInheritLabel(effective.models.fallbacks, models, translator) : null;
	return (
		<SettingsGroup title={title}>
			{!openrouterKey && effective && showKeyNote ? (
				<p className="px-3.5 py-1 text-xs text-muted-foreground" role="note">
					{t("settings.models.keyNote")}
				</p>
			) : null}

			{MODEL_ROWS.map((row) =>
				isVisible(row.itemId) ? (
					<SettingRow
						caption={
							effective ? (
								<ModelCapabilityWarning
									message={modelSettingWarning(row.setting, modelPickerValue(effective.models[row.setting]), models, translator)}
								/>
							) : null
						}
						description={t(ROW_TEXT[row.setting].description)}
						htmlFor={`settings-model-${row.setting}`}
						icon={row.icon}
						key={row.setting}
						label={t(ROW_TEXT[row.setting].label)}
					>
						{effective ? (
							<ModelPicker
								emptyLabel={
									(row.setting === "maintenance"
										? maintenanceInheritLabel(effective.models.maintenance, effective.models.default, models, openrouterKey, translator)
										: modelInheritLabel(effective.models[row.setting], models, t(ROW_TEXT[row.setting].empty), translator)) ?? t("settings.models.inherit")
								}
								id={`settings-model-${row.setting}`}
								loading={modelsLoading}
								models={row.setting === "image" && imageModels.length > 0 ? [...imageModels] : modelsForSetting(row.setting, models)}
								onChange={(id) => onChange(modelPatch(row.setting, id))}
								noChatgpt={MODEL_SETTING_NO_CHATGPT[row.setting] === true}
								requireImage={row.setting === "vision"}
								openrouterOnly={MODEL_SETTING_OPENROUTER_ONLY[row.setting]}
								value={modelPickerValue(effective.models[row.setting])}
							/>
						) : (
							<p className="text-body text-muted-foreground">{t("common.loading")}</p>
						)}
					</SettingRow>
				) : null,
			)}
			{dictation && isVisible("modelos.ditado") ? (
				<SettingRow
					description={t("settings.models.stt.description")}
					htmlFor="settings-model-stt"
					icon={MicIcon}
					label={t("settings.models.stt.label")}
				>
					{effective ? (
						<ModelPicker
							emptyLabel={dictationDefaultLabel(dictation.defaultModel, dictationModels, translator)}
							id="settings-model-stt"
							loading={dictationLoading}
							models={dictationModels}
							onChange={(id) => onChange(modelPatch("stt", id))}
							openrouterOnly
							value={modelPickerValue(effective.models.stt)}
						/>
					) : (
						<p className="text-body text-muted-foreground">{t("common.loading")}</p>
					)}
				</SettingRow>
			) : null}

			{isVisible("modelos.reserva") && effective ? (
				<SettingRow
					caption={
						fallbackList.length === 0 && fallbackInherit ? <p>{fallbackInherit}</p> : null
					}
					description={t("settings.models.fallbacks.description", { max: MAX_FALLBACK_MODELS })}
					icon={LayersIcon}
					label={t("settings.models.fallbacks.label")}
				>
					<FallbacksControl
						list={fallbackList}
						models={models}
						onChange={(list) => onChange(fallbacksPatch(list))}
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

/** Até 3 seletores compactos; sem nenhum, mostra o valor herdado e um botão para adicionar. */
function FallbacksControl({
	list,
	models,
	onChange,
}: {
	list: string[];
	models: readonly OpenRouterModel[];
	onChange: (list: string[]) => void;
}) {
	const t = useT();
	const [adding, setAdding] = useState(false);
	const showNew = adding && list.length < MAX_FALLBACK_MODELS;
	return (
		<div className="flex w-full flex-col gap-2">
			{list.map((id, index) => (
				<div className="flex items-center gap-1" key={id}>
					<ModelPicker
						models={models.slice()}
						onChange={(next) => onChange(setFallbackAt(list, index, next))}
						noChatgpt
						value={id}
					/>
					<Button
						aria-label={t("settings.models.fallbacks.removeAria", { n: index + 1 })}
						onClick={() => onChange(removeFallbackAt(list, index))}
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
							onChange(setFallbackAt(list, list.length, next));
						}}
						noChatgpt
						value=""
					/>
					<Button
						aria-label={t("settings.models.fallbacks.cancelAria")}
						onClick={() => setAdding(false)}
						size="icon-sm"
						variant="ghost"
					>
						<XIcon aria-hidden />
					</Button>
				</div>
			) : null}
			<div className="flex items-center gap-2">
				{list.length < MAX_FALLBACK_MODELS && !showNew ? (
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

export function ModelsSettings({
	account,
	isVisible,
	title,
	showStatus,
	showKeyNote,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible?: (itemId: string) => boolean;
	title?: string;
	showStatus?: boolean;
	showKeyNote?: boolean;
}) {
	const { models, loading } = useOpenRouterModels();
	const imageModels = useOpenRouterImageModels();
	const dictation = useTranscriptionModels();
	return (
		<ModelsSettingsView
			effective={account.view?.effective ?? null}
			isVisible={isVisible}
			loadError={account.loadError}
			models={models}
			imageModels={imageModels.models}
			dictation={dictation.data}
			dictationLoading={dictation.loading}
			modelsLoading={loading}
			onChange={(patch) => void account.save(patch)}
			openrouterKey={account.view?.capabilities.openrouterKey ?? true}
			saveError={account.saveError}
			showKeyNote={showKeyNote}
			showStatus={showStatus}
			status={account.status}
			title={title}
		/>
	);
}
