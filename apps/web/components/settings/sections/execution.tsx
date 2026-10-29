"use client";

import {
	CornerDownRightIcon,
	DollarSignIcon,
	FootprintsIcon,
	GlobeIcon,
	HourglassIcon,
	LayersIcon,
	ListOrderedIcon,
	MessagesSquareIcon,
	SmilePlusIcon,
	RabbitIcon,
	ScrollTextIcon,
	TextCursorIcon,
	TimerIcon,
	TurtleIcon,
} from "lucide-react";
import {
	type AccountConfigPatch,
	type EffectiveAccountConfig,
	type Resolved,
} from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Switch } from "@workspace/ui/components/switch";
import { AutonomySettings } from "@/components/ui/templates/template-4/autonomy/autonomy-settings";
import {
	SettingsPicker,
	type SettingsIcon,
	withOptionIcons,
} from "@/components/ui/templates/template-4/settings-picker";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import type { SaveStatus } from "../account-settings-state";
import {
	MAX_COST_SPEC,
	MAX_OUTPUT_SPEC,
	MAX_STEPS_SPEC,
	TOOL_RESULT_SPEC,
	MAX_WALL_SPEC,
	type ExecutionNumberKey,
	type NumberSettingSpec,
	contextMemoryShort,
	contextEconomyPatch,
	contextMemoryOptions,
	contextMemoryPatch,
	disciplinePatch,
	reactionOnlyPatch,
	numberChoice,
	numberOptions,
	numberPatch,
	switchInheritNote,
	timeoutChoice,
	timeoutOptions,
	timeoutPatch,
} from "../jev-execution-state";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";
import { useT, useTranslations } from "@/lib/i18n/provider";
import type { Translator } from "@/lib/i18n/translator";
import { formatCostUsdNone, formatToolResultChars } from "../jev-execution-state";

type NumberRow = {
	key: ExecutionNumberKey;
	itemId: string;
	icon: SettingsIcon;
	spec: NumberSettingSpec;
	/** Texto de "Herdar" quando nada define o valor. */
	noneLabel: (translator: Translator) => string;
};

const TIMEOUT_ICONS = {
	inherit: CornerDownRightIcon,
	short: RabbitIcon,
	default: TimerIcon,
	extended: TurtleIcon,
};

const noLimit = ({ t }: Translator) => t("settings.exec.noLimit");

/** Rótulo e descrição de cada linha vêm do dicionário: `settings.exec.<chave>.label|description`. */
const NUMBER_ROWS: readonly NumberRow[] = [
	{ key: "maxOutputTokens", itemId: "execucao.resposta", icon: TextCursorIcon, spec: MAX_OUTPUT_SPEC, noneLabel: noLimit },
	{
		key: "toolResultMaxChars",
		itemId: "execucao.resultado",
		icon: ScrollTextIcon,
		spec: TOOL_RESULT_SPEC,
		noneLabel: (translator) => formatToolResultChars(20_000, translator),
	},
	{ key: "maxSteps", itemId: "execucao.passos", icon: FootprintsIcon, spec: MAX_STEPS_SPEC, noneLabel: noLimit },
	{ key: "maxWallMinutes", itemId: "execucao.tempo", icon: HourglassIcon, spec: MAX_WALL_SPEC, noneLabel: noLimit },
	{ key: "maxRunCostUsd", itemId: "execucao.custo", icon: DollarSignIcon, spec: MAX_COST_SPEC, noneLabel: (translator) => formatCostUsdNone(translator) },
];

const NUMBER_TEXT = {
	maxOutputTokens: { label: "settings.exec.maxOutputTokens.label", description: "settings.exec.maxOutputTokens.description" },
	toolResultMaxChars: { label: "settings.exec.toolResultMaxChars.label", description: "settings.exec.toolResultMaxChars.description" },
	maxSteps: { label: "settings.exec.maxSteps.label", description: "settings.exec.maxSteps.description" },
	maxWallMinutes: { label: "settings.exec.maxWallMinutes.label", description: "settings.exec.maxWallMinutes.description" },
	maxRunCostUsd: { label: "settings.exec.maxRunCostUsd.label", description: "settings.exec.maxRunCostUsd.description" },
} as const;

/** Linha com switch: a origem do valor herdado vira legenda à esquerda e, se o usuário mexeu, "Voltar ao padrão" fica ao lado do switch. */
export function SwitchRow({
	id,
	icon,
	label,
	description,
	resolved,
	onChange,
	onInherit,
}: {
	id: string;
	icon?: SettingsIcon;
	label: string;
	description: string;
	resolved: Resolved<boolean> | null;
	onChange: (checked: boolean) => void;
	/** Sem `onInherit` (coluna que não aceita limpar), não há "Voltar ao padrão". */
	onInherit?: () => void;
}) {
	const translator = useTranslations();
	const note = resolved ? switchInheritNote(resolved, translator) : null;
	return (
		<SettingRow
			caption={
				note ? (
					<p className="text-xs text-muted-foreground" id={`${id}-hint`}>
						{note}
					</p>
				) : null
			}
			control="inline"
			description={description}
			htmlFor={id}
			icon={icon}
			label={label}
		>
			{resolved?.source === "user" && onInherit ? (
				<Button onClick={onInherit} size="xs" variant="ghost">
					{translator.t("settings.exec.backToDefault")}
				</Button>
			) : null}
			<Switch
				aria-describedby={note ? `${id}-hint` : undefined}
				checked={resolved?.value ?? false}
				disabled={!resolved}
				id={id}
				onCheckedChange={onChange}
			/>
		</SettingRow>
	);
}

/**
 * Tela Execução: como o agente roda (disciplina, prazos, limites), o
 * navegador automático e a autonomia da conta. Cada controle salva na hora.
 */
export function ExecutionSettingsView({
	effective,
	status,
	saveError,
	loadError,
	onChange,
	onSandboxChange,
	isVisible = () => true,
	title,
	showStatus = true,
}: {
	title?: string;
	/** "Salvo"/erro no fim do grupo. */
	showStatus?: boolean;
	/** `null` enquanto carrega. */
	effective: EffectiveAccountConfig | null;
	status: SaveStatus;
	saveError?: string | null;
	loadError?: string | null;
	onChange: (patch: AccountConfigPatch) => void;
	onSandboxChange: (enabled: boolean) => void;
	isVisible?: (itemId: string) => boolean;
}) {
	const translator = useTranslations();
	const { t } = translator;
	return (
		<SettingsGroup title={title ?? t("settings.exec.title")}>
				{isVisible("execucao.disciplina") ? (
					<SwitchRow
						description={t("settings.exec.discipline.description")}
						icon={ListOrderedIcon}
						id="settings-exec-discipline"
						label={t("settings.exec.discipline.label")}
						onChange={(checked) => onChange(disciplinePatch(checked))}
						onInherit={() => onChange({ execution: { discipline: null } })}
						resolved={effective?.execution.discipline ?? null}
					/>
				) : null}

				{isVisible("execucao.economia") ? (
					<SwitchRow
						description={t("settings.exec.economy.description")}
						icon={LayersIcon}
						id="settings-exec-context-economy"
						label={t("settings.exec.economy.label")}
						onChange={(checked) => onChange(contextEconomyPatch(checked))}
						onInherit={() => onChange({ execution: { contextEconomy: null } })}
						resolved={effective?.execution.contextEconomy ?? null}
					/>
				) : null}

				{isVisible("execucao.memoria") ? (
					<SettingRow
						caption={
							<p className="text-xs text-muted-foreground">
								{contextMemoryShort(effective?.execution.contextMemory?.value ?? "standard", translator)}
							</p>
						}
						description={t("settings.exec.memory.description")}
						htmlFor="settings-exec-context-memory"
						icon={MessagesSquareIcon}
						label={t("settings.exec.memory.label")}
					>
						<SettingsPicker
							className="w-full"
							disabled={!effective}
							id="settings-exec-context-memory"
							onChange={(choice) => onChange(contextMemoryPatch(choice))}
							options={contextMemoryOptions(translator)}
							placeholder={t("common.loading")}
							value={effective ? (effective.execution.contextMemory?.value ?? "standard") : ""}
						/>
					</SettingRow>
				) : null}

				{isVisible("execucao.reacao") ? (
					<SwitchRow
						description={t("settings.exec.reaction.description")}
						icon={SmilePlusIcon}
						id="settings-exec-reaction-only"
						label={t("settings.exec.reaction.label")}
						onChange={(checked) => onChange(reactionOnlyPatch(checked))}
						onInherit={() => onChange({ execution: { reactionOnly: null } })}
						resolved={effective?.execution.reactionOnly ?? null}
					/>
				) : null}

				{isVisible("execucao.paciencia") ? (
					<SettingRow
						description={t("settings.exec.patience.description")}
						htmlFor="settings-exec-timeout"
						icon={TimerIcon}
						label={t("settings.exec.patience.label")}
					>
						<SettingsPicker
							className="w-full"
							disabled={!effective}
							id="settings-exec-timeout"
							onChange={(choice) => onChange(timeoutPatch(choice))}
							options={
								effective
									? withOptionIcons(timeoutOptions(effective.execution.llmTimeouts, translator), TIMEOUT_ICONS)
									: []
							}
							placeholder={t("common.loading")}
							value={effective ? timeoutChoice(effective.execution.llmTimeouts) : ""}
						/>
					</SettingRow>
				) : null}

				{NUMBER_ROWS.map((row) =>
					isVisible(row.itemId) ? (
						<SettingRow
							description={t(NUMBER_TEXT[row.key].description)}
							htmlFor={`settings-exec-${row.key}`}
							icon={row.icon}
							key={row.key}
							label={t(NUMBER_TEXT[row.key].label)}
						>
							<SettingsPicker
								className="w-full"
								disabled={!effective}
								id={`settings-exec-${row.key}`}
								onChange={(choice) => onChange(numberPatch(row.key, choice))}
								options={effective ? numberOptions(row.spec, effective.execution[row.key], row.noneLabel(translator), translator) : []}
								placeholder={t("common.loading")}
								value={effective ? numberChoice(effective.execution[row.key]) : ""}
							/>
						</SettingRow>
					) : null,
				)}

				{isVisible("execucao.navegador") ? (
					<SwitchRow
						description={t("settings.exec.browser.description")}
						icon={GlobeIcon}
						id="settings-exec-sandbox"
						label={t("settings.exec.browser.label")}
						onChange={onSandboxChange}
						resolved={effective?.sandboxAutoStart ?? null}
					/>
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

/** Autonomia da conta: nível padrão (cada bot pode herdar ou ter o seu) e as exceções. */
export function AccountAutonomyGroup({ title, isVisible = () => true }: { title?: string; isVisible?: (itemId: string) => boolean }) {
	const t = useT();
	if (!isVisible("execucao.autonomia")) return null;
	return (
		<SettingsGroup title={title ?? t("settings.exec.autonomyTitle")}>
			<AutonomySettings scope="account" variant="row" />
		</SettingsGroup>
	);
}

export function ExecutionSettings({
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
	return (
		<ExecutionSettingsView
			effective={account.view?.effective ?? null}
			isVisible={isVisible}
			loadError={account.loadError}
			onChange={(patch) => void account.save(patch)}
			onSandboxChange={(enabled) => void account.save({}, { sandboxAutoStart: enabled })}
			saveError={account.saveError}
			showStatus={showStatus}
			status={account.status}
			title={title}
		/>
	);
}

