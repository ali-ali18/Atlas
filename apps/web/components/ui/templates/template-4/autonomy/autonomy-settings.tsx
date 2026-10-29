"use client";

import { useState } from "react";
import { ShieldQuestionIcon } from "lucide-react";
import {
	AUTONOMY_LEVELS,
	AUTONOMY_LEVEL_DESCRIPTIONS,
	AUTONOMY_LEVEL_LABELS,
	formatAutonomyRemaining,
	type AutonomyDuration,
	type AutonomyLevel,
} from "@workspace/shared";
import { SettingRow } from "@/components/settings/setting-row";
import { useAutonomy } from "@/hooks/use-autonomy";
import { AutonomyExceptions } from "./autonomy-exceptions";
import { SettingsPicker } from "../settings-picker";
import { AutonomyValidityButton } from "./autonomy-validity-button";

/**
 * Autonomia de um escopo: um select de nível (no bot, com "Herdar da conta"),
 * o relógio de validade quando não herda e, só na conta, as exceções. Salva na hora.
 */
export function AutonomySettings({
	scope,
	botId,
	connectorFilter,
	variant = "stack",
}: {
	/** `row`: uma linha de configurações (rótulo + seletor) em vez do bloco empilhado. */
	variant?: "stack" | "row";
	scope: "account" | "bot";
	botId?: string;
	/** Chave do conector (vem do Marketplace): abre as exceções filtradas nele. */
	connectorFilter?: string;
}) {
	const { view, connections, loading, saving, error, save } = useAutonomy(
		scope,
		botId,
	);
	// Validade escolhida nesta sessão: reaplicada ao trocar de nível.
	const [duration, setDuration] = useState<AutonomyDuration | null>(null);

	const rowLabel = scope === "account" ? "Autonomia padrão" : "Autonomia";
	if (loading) {
		return variant === "row" ? (
			<SettingRow control="inline" icon={ShieldQuestionIcon} label={rowLabel}>
				<span className="text-body text-muted-foreground">Carregando autonomia…</span>
			</SettingRow>
		) : (
			<p className="text-sm text-muted-foreground">Carregando autonomia…</p>
		);
	}
	if (!view) {
		const message = error ?? "Não foi possível carregar a autonomia.";
		return variant === "row" ? (
			<SettingRow control="inline" icon={ShieldQuestionIcon} label={rowLabel}>
				<span className="text-body text-destructive" role="alert">
					{message}
				</span>
			</SettingRow>
		) : (
			<p className="text-sm text-destructive" role="alert">
				{message}
			</p>
		);
	}

	const now = new Date();
	const stored = view.stored;
	const inherits = scope === "bot" && !stored?.level;
	const selected: AutonomyLevel | "inherit" = inherits
		? "inherit"
		: view.effective.level;
	const activeUntil =
		stored?.until && Date.parse(stored.until) > now.getTime()
			? stored.until
			: null;
	const durationValue: AutonomyDuration | "current" =
		duration ?? (activeUntil ? "current" : "forever");
	const labels: Record<AutonomyLevel | "inherit", string> = {
		inherit: `Herdar (${AUTONOMY_LEVEL_LABELS[view.effective.level]})`,
		...AUTONOMY_LEVEL_LABELS,
	};
	const values = scope === "bot" ? (["inherit", ...AUTONOMY_LEVELS] as const) : AUTONOMY_LEVELS;
	const helper =
		selected === "inherit"
			? "Usa o padrão definido nas configurações da conta."
			: AUTONOMY_LEVEL_DESCRIPTIONS[selected];
	const until = activeUntil
		? ` · até ${new Date(activeUntil).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`
		: "";

	const levelPicker = (
		<>
			<SettingsPicker
				aria-label="Nível de autonomia"
				className={variant === "row" ? undefined : "min-w-0 flex-1"}
				disabled={saving}
				id={`autonomy-level-${scope}`}
				onChange={(value) => {
					void save(
						value === "inherit"
							? { level: null }
							: { level: value, duration: duration ?? "forever" },
					);
				}}
				options={values.map((value) => ({
					value,
					label: labels[value],
					description:
						value === "inherit"
							? "Usa o padrão definido nas configurações da conta."
							: AUTONOMY_LEVEL_DESCRIPTIONS[value],
				}))}
				value={selected}
			/>
			{selected !== "inherit" ? (
				<AutonomyValidityButton
					active={Boolean(activeUntil)}
					currentLabel={
						activeUntil ? `Mais ${formatAutonomyRemaining(activeUntil, now)}` : undefined
					}
					disabled={saving}
					onChange={(next) => {
						setDuration(next);
						void save({ duration: next });
					}}
					value={durationValue}
				/>
			) : null}
		</>
	);
	const exceptions =
		scope === "account" ? (
			<AutonomyExceptions
				connections={connections}
				connectorFilter={connectorFilter}
				disabled={saving}
				exceptions={stored?.exceptions ?? []}
				key={connectorFilter ?? "all"}
				onChange={(next) => void save({ exceptions: next })}
			/>
		) : null;

	if (variant === "row") {
		return (
			<>
				<SettingRow
					caption={
						error ? (
							<p className="text-destructive" role="alert">
								{error}
							</p>
						) : null
					}
					control="inline"
					description={`${helper}${selected !== "inherit" ? until : ""}`}
					icon={ShieldQuestionIcon}
					label={rowLabel}
				>
					{levelPicker}
				</SettingRow>
				{exceptions ? <div className="px-3.5 pb-1">{exceptions}</div> : null}
			</>
		);
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">{levelPicker}</div>
			<p className="text-xs text-muted-foreground">
				{helper}
				{selected !== "inherit" ? until : ""}
			</p>
			{error ? (
				<p className="text-xs text-destructive" role="alert">
					{error}
				</p>
			) : null}
			{exceptions}
		</div>
	);
}
