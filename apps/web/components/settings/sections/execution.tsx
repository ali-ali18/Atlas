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
	MAX_WALL_SPEC,
	formatCostUsdNone,
	type ExecutionNumberKey,
	type NumberSettingSpec,
	CONTEXT_MEMORY_SHORT,
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

type NumberRow = {
	key: ExecutionNumberKey;
	itemId: string;
	label: string;
	icon: SettingsIcon;
	description: string;
	spec: NumberSettingSpec;
	/** Texto de "Herdar" quando nada define o valor. */
	noneLabel: string;
};

const TIMEOUT_ICONS = {
	inherit: CornerDownRightIcon,
	short: RabbitIcon,
	default: TimerIcon,
	extended: TurtleIcon,
};

const NUMBER_ROWS: readonly NumberRow[] = [
	{
		key: "maxOutputTokens",
		itemId: "execucao.resposta",
		label: "Tamanho máximo da resposta",
		icon: TextCursorIcon,
		description: "Limite de tokens por resposta do modelo. Menor é mais rápido, mas pode cortar respostas longas.",
		spec: MAX_OUTPUT_SPEC,
		noneLabel: "sem limite",
	},
	{
		key: "maxSteps",
		itemId: "execucao.passos",
		label: "Limite de passos",
		icon: FootprintsIcon,
		description: "Máximo de passos por run, quando o bot não define o seu.",
		spec: MAX_STEPS_SPEC,
		noneLabel: "sem limite",
	},
	{
		key: "maxWallMinutes",
		itemId: "execucao.tempo",
		label: "Limite de tempo",
		icon: HourglassIcon,
		description: "Quanto um run pode durar, quando o bot não define o seu.",
		spec: MAX_WALL_SPEC,
		noneLabel: "sem limite",
	},
	{
		key: "maxRunCostUsd",
		itemId: "execucao.custo",
		label: "Custo máximo por execução",
		icon: DollarSignIcon,
		description: "Para a execução quando o custo chegar a este valor. Antes disso, o agente entrega o que tem.",
		spec: MAX_COST_SPEC,
		noneLabel: formatCostUsdNone,
	},
];

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
	const note = resolved ? switchInheritNote(resolved) : null;
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
					Voltar ao padrão
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
	title = "Execução",
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
	return (
		<SettingsGroup title={title}>
				{isVisible("execucao.disciplina") ? (
					<SwitchRow
						description="Acompanha o progresso do agente, percebe quando ele empaca e agrupa chamadas parecidas."
						icon={ListOrderedIcon}
						id="settings-exec-discipline"
						label="Disciplina de execução"
						onChange={(checked) => onChange(disciplinePatch(checked))}
						onInherit={() => onChange({ execution: { discipline: null } })}
						resolved={effective?.execution.discipline ?? null}
					/>
				) : null}

				{isVisible("execucao.economia") ? (
					<SwitchRow
						description="Carrega as ferramentas e instruções só quando o pedido precisa delas. Gasta menos contexto e fica mais rápido; desligue se o agente não achar uma ferramenta."
						icon={LayersIcon}
						id="settings-exec-context-economy"
						label="Economia de contexto"
						onChange={(checked) => onChange(contextEconomyPatch(checked))}
						onInherit={() => onChange({ execution: { contextEconomy: null } })}
						resolved={effective?.execution.contextEconomy ?? null}
					/>
				) : null}

				{isVisible("execucao.memoria") ? (
					<SettingRow
						caption={
							<p className="text-xs text-muted-foreground">
								{CONTEXT_MEMORY_SHORT[effective?.execution.contextMemory?.value ?? "standard"]}
							</p>
						}
						description="Como o agente cuida do histórico de uma conversa longa: manter quase tudo e resumir perto do limite do modelo, ou enxugar cedo."
						htmlFor="settings-exec-context-memory"
						icon={MessagesSquareIcon}
						label="Memória da conversa"
					>
						<SettingsPicker
							className="w-full"
							disabled={!effective}
							id="settings-exec-context-memory"
							onChange={(choice) => onChange(contextMemoryPatch(choice))}
							options={contextMemoryOptions()}
							placeholder="Carregando…"
							value={effective ? (effective.execution.contextMemory?.value ?? "standard") : ""}
						/>
					</SettingRow>
				) : null}

				{isVisible("execucao.reacao") ? (
					<SwitchRow
						description="Quando você manda só um “ok”, “valeu” ou um emoji, o bot reage em vez de responder. Gasta menos e evita resposta à toa. Se ele tiver feito uma pergunta ou houver algo esperando você, ele responde normalmente."
						icon={SmilePlusIcon}
						id="settings-exec-reaction-only"
						label="Responder só com reação quando não precisa de resposta"
						onChange={(checked) => onChange(reactionOnlyPatch(checked))}
						onInherit={() => onChange({ execution: { reactionOnly: null } })}
						resolved={effective?.execution.reactionOnly ?? null}
					/>
				) : null}

				{isVisible("execucao.paciencia") ? (
					<SettingRow
						description="Quanto esperar por uma resposta do modelo antes de desistir e tentar outro."
						htmlFor="settings-exec-timeout"
						icon={TimerIcon}
						label="Paciência com o modelo"
					>
						<SettingsPicker
							className="w-full"
							disabled={!effective}
							id="settings-exec-timeout"
							onChange={(choice) => onChange(timeoutPatch(choice))}
							options={
								effective
									? withOptionIcons(timeoutOptions(effective.execution.llmTimeouts), TIMEOUT_ICONS)
									: []
							}
							placeholder="Carregando…"
							value={effective ? timeoutChoice(effective.execution.llmTimeouts) : ""}
						/>
					</SettingRow>
				) : null}

				{NUMBER_ROWS.map((row) =>
					isVisible(row.itemId) ? (
						<SettingRow
							description={row.description}
							htmlFor={`settings-exec-${row.key}`}
							icon={row.icon}
							key={row.key}
							label={row.label}
						>
							<SettingsPicker
								className="w-full"
								disabled={!effective}
								id={`settings-exec-${row.key}`}
								onChange={(choice) => onChange(numberPatch(row.key, choice))}
								options={effective ? numberOptions(row.spec, effective.execution[row.key], row.noneLabel) : []}
								placeholder="Carregando…"
								value={effective ? numberChoice(effective.execution[row.key]) : ""}
							/>
						</SettingRow>
					) : null,
				)}

				{isVisible("execucao.navegador") ? (
					<SwitchRow
						description="Liga o navegador do agente sozinho quando um run precisa dele."
						icon={GlobeIcon}
						id="settings-exec-sandbox"
						label="Iniciar o navegador automaticamente"
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
export function AccountAutonomyGroup({ title = "Autonomia", isVisible = () => true }: { title?: string; isVisible?: (itemId: string) => boolean }) {
	if (!isVisible("execucao.autonomia")) return null;
	return (
		<SettingsGroup title={title}>
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

