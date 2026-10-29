"use client";

import { useState } from "react";
import { ArrowUpIcon, PlusIcon, ScanSearchIcon, SignalHighIcon, SignalLowIcon, SignalMediumIcon, XIcon } from "lucide-react";
import {
	MAX_TIER_MODELS,
	MODEL_TIER_LABELS,
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

export const TIER_CAPTION = `Até ${MAX_TIER_MODELS} modelos por nível; o primeiro é o principal, os outros entram se ele falhar.`;

export const TIER_ROWS: ReadonlyArray<{ tier: ModelTier; itemId: string; icon: SettingsIcon; description: string }> = [
	{ tier: "easy", itemId: "modelos.nivel-facil", icon: SignalLowIcon, description: "Conversa e perguntas curtas." },
	{ tier: "medium", itemId: "modelos.nivel-media", icon: SignalMediumIcon, description: "Consultas de dados, arquivos, conectores e navegador." },
	{ tier: "hard", itemId: "modelos.nivel-dificil", icon: SignalHighIcon, description: "Código, terminal, computador e tarefas longas." },
];

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
						aria-label={`Subir ${label} ${index + 1}`}
						disabled={index === 0}
						onClick={() => onChange(moveTierModelUp(list, index))}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowUpIcon aria-hidden />
					</Button>
					<Button
						aria-label={`Remover ${label} ${index + 1}`}
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
					<Button aria-label={`Cancelar novo modelo de ${label}`} onClick={() => setAdding(false)} size="icon-sm" variant="ghost">
						<XIcon aria-hidden />
					</Button>
				</div>
			) : null}
			<div className="flex items-center gap-2 empty:hidden">
				{list.length < MAX_TIER_MODELS && !showNew ? (
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
	return (
		<div data-slot="tier-row">
			<SettingRow
				caption={caption ? <p>{caption}</p> : null}
				description={row.description}
				icon={row.icon}
				label={MODEL_TIER_LABELS[row.tier]}
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
	return (
		<SettingsGroup title={title}>
			{TIER_ROWS.some((row) => isVisible(row.itemId)) ? (
				<p className="px-3.5 py-1 text-xs text-muted-foreground" role="note">
					{TIER_CAPTION}
				</p>
			) : null}
			{TIER_ROWS.map((row) =>
				isVisible(row.itemId) ? (
					<TierRow
						caption={effective && userTierModels(effective.models.tiers, row.tier).length === 0 ? "Usa o modelo padrão." : null}
						row={row}
						key={row.tier}
					>
						{effective ? (
							<TierModelsControl
								label={MODEL_TIER_LABELS[row.tier]}
								list={userTierModels(effective.models.tiers, row.tier)}
								models={models}
								onChange={(list) => onChange(tierPatch(row.tier, list))}
							/>
						) : (
							<p className="text-body text-muted-foreground">Carregando…</p>
						)}
					</TierRow>
				) : null,
			)}
			{isVisible("modelos.classificador") ? (
				<SettingRow
					caption={<p>Mais preciso, custa um pouco mais por mensagem.</p>}
					control="inline"
					description="O revisor lê o pedido e escolhe o nível; sem ele, regras locais decidem."
					htmlFor="settings-model-classifier"
					icon={ScanSearchIcon}
					label="Classificar com o revisor"
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
