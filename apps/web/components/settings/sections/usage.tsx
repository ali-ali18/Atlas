"use client";

import { useState } from "react";
import { ActivityIcon, CalendarIcon, DollarSignIcon } from "lucide-react";
import {
	USAGE_OTHERS_KEY,
	modelDisplayName,
	type OpenRouterModel,
	type UsagePeriod,
	type UsageResponse,
	type UsageTotals,
} from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { OpenAIIcon } from "@/components/icons/openai";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { SettingsPicker, type SettingsIcon } from "@/components/ui/templates/template-4/settings-picker";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";
import { useUsage } from "@/hooks/use-usage";
import { SettingRow, SettingsGroup } from "../setting-row";
import {
	barPercent,
	rowCostLabel,
	runsLabel,
	tokensLabel,
	totalCostLabel,
	usagePeriodOptions,
} from "../usage-state";
import { useTranslations } from "@/lib/i18n/provider";

/** Fornecedor do id (ícone): o plano ChatGPT usa a marca da OpenAI. */
function vendorOf(modelId: string): string {
	if (modelId.startsWith("chatgpt/")) return "openai";
	if (modelId.startsWith("anthropic-direct/")) return "anthropic";
	if (modelId.startsWith("opencode-go/")) return "opencode";
	return modelId.includes("/") ? (modelId.split("/")[0] ?? "openrouter") : "openrouter";
}

type BreakdownRow = {
	key: string;
	label: string;
	icon?: string;
	totals: UsageTotals;
};

/** Lista compacta: nome, custo, execuções e uma barra proporcional simples. */
function Breakdown({ title, rows }: { title: string; rows: BreakdownRow[] }) {
	const translator = useTranslations();
	const { t } = translator;
	if (rows.length === 0) return null;
	const all = rows.map((row) => row.totals);
	return (
		<section aria-label={title} className="flex flex-col gap-2">
			<h3 className="text-sm font-medium">{title}</h3>
			<ul className="flex flex-col gap-3">
				{rows.map((row) => (
					<li className="flex flex-col gap-1" key={row.key}>
						<div className="flex items-center justify-between gap-3 text-sm">
							<span className="flex min-w-0 items-center gap-2">
								{row.icon ? <ModelSelectorLogo provider={row.icon} /> : null}
								<span className="truncate">{row.label}</span>
							</span>
							<span className="flex shrink-0 items-center gap-2 text-muted-foreground">
								<span
									className="text-xs text-muted-foreground"
									title={row.totals.planCalls > 0 ? t("settings.usage.planTooltip") : undefined}
								>
									{rowCostLabel(row.totals, translator)}
								</span>
								<span className="text-xs">{runsLabel(row.totals.runs, translator)}</span>
							</span>
						</div>
						<div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary"
								style={{ width: `${barPercent(row.totals, all)}%` }}
							/>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

function Stat({
	label,
	value,
	hint,
	icon: Icon,
}: {
	label: string;
	value: string;
	hint?: string;
	icon: SettingsIcon;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/60 p-3">
			<dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Icon aria-hidden className="size-3.5 shrink-0" />
				{label}
			</dt>
			<dd className="text-base font-medium break-words">{value}</dd>
			{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
		</div>
	);
}

/** Seção Uso (só apresentação): cabeçalho com período, totais, por bot e por modelo. */
export function UsageSettingsView({
	period,
	onPeriodChange,
	data,
	loading,
	error,
	onRetry,
	models = [],
}: {
	period: UsagePeriod;
	onPeriodChange: (period: UsagePeriod) => void;
	data: UsageResponse | null;
	loading: boolean;
	error: string | null;
	onRetry: () => void;
	models?: readonly OpenRouterModel[];
}) {
	const translator = useTranslations();
	const { t, locale } = translator;
	const names = new Map(models.map((model) => [model.id, model.name]));
	const modelRows: BreakdownRow[] = (data?.byModel ?? []).map((row) => ({
		key: row.key,
		label: row.key === USAGE_OTHERS_KEY ? row.model : modelDisplayName(names.get(row.model), row.model),
		icon: row.key === USAGE_OTHERS_KEY ? undefined : vendorOf(row.model),
		totals: row,
	}));
	const botRows: BreakdownRow[] = (data?.byBot ?? []).map((row) => ({
		key: row.key,
		label: row.name,
		totals: row,
	}));
	const totals = data?.totals;

	return (
		<div className="flex flex-col gap-6">
			<SettingsGroup title={t("settings.usage.periodGroup")}>
				<SettingRow
					description={t("settings.usage.windowHint")}
					htmlFor="settings-usage-period"
					icon={CalendarIcon}
					label={t("settings.usage.window")}
				>
					<SettingsPicker
						id="settings-usage-period"
						onChange={onPeriodChange}
						options={usagePeriodOptions(translator)}
						value={period}
					/>
				</SettingRow>
			</SettingsGroup>

			{error ? (
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
					<Button onClick={onRetry} size="sm" variant="outline">
						{t("common.retry")}
					</Button>
				</div>
			) : null}

			{loading && !data ? (
				<p aria-live="polite" className="text-sm text-muted-foreground" role="status">
					{t("common.loading")}
				</p>
			) : null}

			{totals && totals.runs === 0 ? (
				<p className="text-sm text-muted-foreground">{t("settings.usage.empty")}</p>
			) : null}

			{totals && totals.runs > 0 ? (
				<>
					<dl aria-busy={loading} className="grid gap-3 sm:grid-cols-3">
						<Stat icon={DollarSignIcon} label={t("settings.usage.cost")} value={totalCostLabel(totals, translator)} />
						<Stat icon={OpenAIIcon} label={t("settings.usage.planCalls")} value={String(totals.planCalls)} />
						<Stat
							icon={ActivityIcon}
							hint={
								totals.cachedTokens > 0
									? t("settings.usage.tokensCached", {
											input: tokensLabel(totals.promptTokens, locale),
											output: tokensLabel(totals.completionTokens, locale),
											cached: tokensLabel(totals.cachedTokens, locale),
										})
									: t("settings.usage.tokens", {
											input: tokensLabel(totals.promptTokens, locale),
											output: tokensLabel(totals.completionTokens, locale),
										})
							}
							label={t("settings.usage.runsTitle")}
							value={String(totals.runs)}
						/>
					</dl>
					<Breakdown rows={botRows} title={t("settings.usage.byBot")} />
					<Breakdown rows={modelRows} title={t("settings.usage.byModel")} />
				</>
			) : null}
		</div>
	);
}

export function UsageSettings() {
	const [period, setPeriod] = useState<UsagePeriod>("7d");
	const { data, loading, error, reload } = useUsage(period);
	const { models } = useOpenRouterModels();
	return (
		<UsageSettingsView
			data={data}
			error={error}
			loading={loading}
			models={models}
			onPeriodChange={setPeriod}
			onRetry={reload}
			period={period}
		/>
	);
}
