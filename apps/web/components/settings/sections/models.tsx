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
	MODEL_SETTING_OPENROUTER_ONLY,
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

type ModelRowSpec = {
	setting: ModelSetting;
	itemId: string;
	label: string;
	icon: SettingsIcon;
	description: string;
	/** O que mostrar em "Herdar" quando não há valor herdado. */
	emptyText: string;
};

const MODEL_ROWS: readonly ModelRowSpec[] = [
	{
		setting: "default",
		itemId: "modelos.padrao",
		label: "Modelo padrão",
		icon: BotIcon,
		description: "Usado por bots novos e por conversas sem bot.",
		emptyText: "nenhum",
	},
	{
		setting: "coding",
		itemId: "modelos.codigo",
		label: "Modelo para código",
		icon: CodeIcon,
		description: "Entra sozinho quando um bot trabalha numa sessão de código. Cada bot pode escolher o seu.",
		emptyText: "modelo do bot",
	},
	{
		setting: "maintenance",
		itemId: "modelos.manutencao",
		label: "Modelo de manutenção",
		icon: WrenchIcon,
		description: "Resume conversas e revisa a memória. Só modelos do OpenRouter.",
		emptyText: "nenhum",
	},
	{
		setting: "vision",
		itemId: "modelos.visao",
		label: "Modelo para ler imagens",
		icon: EyeIcon,
		description: "Entra quando o modelo do bot não enxerga imagens. Só modelos do OpenRouter.",
		emptyText: "sem reserva",
	},
	{
		setting: "image",
		itemId: "modelos.imagem",
		label: "Modelo para gerar imagens",
		icon: ImageIcon,
		description: "Usado para criar imagens. Só modelos do OpenRouter.",
		emptyText: "desligado",
	},
];

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
	const fallbackList = effective ? userFallbacks(effective.models.fallbacks) : [];
	const dictationModels = dictation ? transcriptionPickerModels(dictation.models) : [];
	const fallbackInherit = effective ? fallbacksInheritLabel(effective.models.fallbacks, models) : null;
	return (
		<SettingsGroup title={title}>
			{!openrouterKey && effective && showKeyNote ? (
				<p className="px-3.5 py-1 text-xs text-muted-foreground" role="note">
					Chave do OpenRouter não configurada no servidor: só o plano ChatGPT (dono) funciona.
				</p>
			) : null}

			{MODEL_ROWS.map((row) =>
				isVisible(row.itemId) ? (
					<SettingRow
						caption={
							effective ? (
								<ModelCapabilityWarning
									message={modelSettingWarning(row.setting, modelPickerValue(effective.models[row.setting]), models)}
								/>
							) : null
						}
						description={row.description}
						htmlFor={`settings-model-${row.setting}`}
						icon={row.icon}
						key={row.setting}
						label={row.label}
					>
						{effective ? (
							<ModelPicker
								emptyLabel={
									modelInheritLabel(effective.models[row.setting], models, row.emptyText) ?? "Herdar"
								}
								id={`settings-model-${row.setting}`}
								loading={modelsLoading}
								models={row.setting === "image" && imageModels.length > 0 ? [...imageModels] : modelsForSetting(row.setting, models)}
								onChange={(id) => onChange(modelPatch(row.setting, id))}
								openrouterOnly={MODEL_SETTING_OPENROUTER_ONLY[row.setting]}
								value={modelPickerValue(effective.models[row.setting])}
							/>
						) : (
							<p className="text-[13px] text-muted-foreground">Carregando…</p>
						)}
					</SettingRow>
				) : null,
			)}
			{dictation && isVisible("modelos.ditado") ? (
				<SettingRow
					description="Transcreve o que você fala no microfone do chat."
					htmlFor="settings-model-stt"
					icon={MicIcon}
					label="Modelo de ditado"
				>
					{effective ? (
						<ModelPicker
							emptyLabel={dictationDefaultLabel(dictation.defaultModel, dictationModels)}
							id="settings-model-stt"
							loading={dictationLoading}
							models={dictationModels}
							onChange={(id) => onChange(modelPatch("stt", id))}
							openrouterOnly
							value={modelPickerValue(effective.models.stt)}
						/>
					) : (
						<p className="text-[13px] text-muted-foreground">Carregando…</p>
					)}
				</SettingRow>
			) : null}

			{isVisible("modelos.reserva") && effective ? (
				<SettingRow
					caption={
						fallbackList.length === 0 && fallbackInherit ? <p>{fallbackInherit}</p> : null
					}
					description={`Tentados quando o modelo principal falha (até ${MAX_FALLBACK_MODELS}). Só modelos do OpenRouter.`}
					icon={LayersIcon}
					label="Modelos de reserva"
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
	const [adding, setAdding] = useState(false);
	const showNew = adding && list.length < MAX_FALLBACK_MODELS;
	return (
		<div className="flex w-full flex-col gap-2">
			{list.map((id, index) => (
				<div className="flex items-center gap-1" key={id}>
					<ModelPicker
						models={models.slice()}
						onChange={(next) => onChange(setFallbackAt(list, index, next))}
						openrouterOnly
						value={id}
					/>
					<Button
						aria-label={`Remover modelo de reserva ${index + 1}`}
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
						openrouterOnly
						value=""
					/>
					<Button
						aria-label="Cancelar novo modelo de reserva"
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
						Adicionar
					</Button>
				) : null}
				{list.length > 0 ? (
					<Button onClick={() => onChange([])} size="sm" variant="ghost">
						Voltar ao padrão
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
