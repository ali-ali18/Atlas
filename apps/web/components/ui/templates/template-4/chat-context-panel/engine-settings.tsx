"use client";

import { useEffect, useRef, useState } from "react";
import { CoinsIcon, CpuIcon, UsersIcon } from "lucide-react";
import { Input } from "@workspace/ui/components/input";
import { readEnginePolicy, readHelperPolicy, withEngineSettings, type EngineSettingsPatch, type RunEngine } from "@workspace/shared";
import { SettingRow } from "@/components/settings/setting-row";
import { ModelPicker } from "@/components/model-picker";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { budgetBlurAction, formatBudgetUsd, parseBudgetMinutes, parseBudgetUsd } from "@/lib/engine-settings";
import { useTranslations } from "@/lib/i18n/provider";
import { SettingsPicker } from "../settings-picker";

/** Campo numérico curto: salva ao sair do campo ou com Enter; Esc cancela; texto inválido volta ao salvo e avisa. */
export function BudgetField({
	id,
	label,
	value,
	suffix,
	invalid,
	describedBy,
	onCommit,
}: {
	id: string;
	label: string;
	value: string;
	suffix: string;
	invalid?: boolean;
	describedBy?: string;
	onCommit: (text: string) => boolean;
}) {
	const [draft, setDraft] = useState(value);
	// Esc cancela: o blur que ele dispara roda com o rascunho antigo do closure, então o cancelamento vai numa ref.
	const cancelled = useRef(false);
	useEffect(() => setDraft(value), [value]);
	function commit() {
		const action = budgetBlurAction({ draft, saved: value, cancelled: cancelled.current });
		cancelled.current = false;
		if (action === "skip") return;
		if (!onCommit(draft)) setDraft(value);
	}
	return (
		<div className="flex items-center gap-1.5">
			<Input
				aria-describedby={invalid ? describedBy : undefined}
				aria-invalid={invalid ? true : undefined}
				aria-label={label}
				className="h-8 w-16 text-right text-body"
				id={id}
				inputMode="decimal"
				onBlur={commit}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") {
						cancelled.current = true;
						setDraft(value);
						event.currentTarget.blur();
					}
				}}
				value={draft}
			/>
			<span className="text-caption text-muted-foreground">{suffix}</span>
		</div>
	);
}

/**
 * Linhas "Motor" da engrenagem do bot (piloto do motor novo). "Atual" é o padrão; "Novo (teste)" trabalha até o fim
 * dentro de um orçamento. Salva em `policyJson` mesclando só as chaves do motor (`withEngineSettings`).
 */
export function EngineSettings({ policyJson, onChange }: { policyJson: unknown; onChange: (patch: { policyJson: unknown }) => void }) {
	const { t } = useTranslations();
	const { models, loading } = useOpenRouterModels();
	const policy = readEnginePolicy(policyJson);
	const helperModel = readHelperPolicy(policyJson).helperModel;
	const save = (patch: EngineSettingsPatch) => onChange({ policyJson: withEngineSettings(policyJson, patch) });
	const isNew = policy.engine === "v2";
	// Qual campo do orçamento recusou o último valor digitado (some ao salvar um valor válido).
	const [rejected, setRejected] = useState<"usd" | "minutes" | null>(null);
	const rejectedText = rejected === "usd" ? t("botSettings.engineBudgetUsdInvalid") : rejected === "minutes" ? t("botSettings.engineBudgetMinutesInvalid") : null;

	return (
		<>
			<SettingRow
				caption={isNew ? <p>{t("botSettings.engineNewHelp")}</p> : undefined}
				description={t("botSettings.engineDesc")}
				htmlFor="agent-engine"
				icon={CpuIcon}
				label={t("botSettings.engine")}
			>
				<SettingsPicker<RunEngine>
					id="agent-engine"
					onChange={(engine) => save({ engine })}
					options={[
						{ value: "v1", label: t("botSettings.engineCurrent") },
						{ value: "v2", label: t("botSettings.engineNew") },
					]}
					value={policy.engine}
				/>
			</SettingRow>
			{isNew ? (
				<>
					<SettingRow
						caption={rejectedText ? <p id="agent-engine-budget-error" role="alert">{rejectedText}</p> : undefined}
						control="inline"
						description={t("botSettings.engineBudgetDesc")}
						icon={CoinsIcon}
						label={t("botSettings.engineBudget")}
						wrap
					>
						<BudgetField
							describedBy="agent-engine-budget-error"
							id="agent-engine-usd"
							invalid={rejected === "usd"}
							label={t("botSettings.engineBudgetUsd")}
							onCommit={(text) => {
								const usd = parseBudgetUsd(text);
								if (usd === null) {
									setRejected("usd");
									return false;
								}
								setRejected(null);
								save({ longWorkBudgetUsd: usd });
								return true;
							}}
							suffix="US$"
							value={formatBudgetUsd(policy.longWorkBudgetUsd)}
						/>
						<BudgetField
							describedBy="agent-engine-budget-error"
							id="agent-engine-minutes"
							invalid={rejected === "minutes"}
							label={t("botSettings.engineBudgetMinutes")}
							onCommit={(text) => {
								const minutes = parseBudgetMinutes(text);
								if (minutes === null) {
									setRejected("minutes");
									return false;
								}
								setRejected(null);
								save({ longWorkMinutes: minutes });
								return true;
							}}
							suffix="min"
							value={String(policy.longWorkMinutes)}
						/>
					</SettingRow>
					<SettingRow description={t("botSettings.engineHelperDesc")} htmlFor="agent-engine-helper" icon={UsersIcon} label={t("botSettings.engineHelper")}>
						<ModelPicker
							emptyLabel={t("botSettings.codingSameAsBot")}
							id="agent-engine-helper"
							loading={loading}
							models={models}
							onChange={(model) => save({ helperModel: model || null })}
							value={helperModel ?? ""}
						/>
					</SettingRow>
				</>
			) : null}
		</>
	);
}
