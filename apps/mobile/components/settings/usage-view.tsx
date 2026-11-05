import { modelDisplayName, type UsagePeriod } from "@workspace/shared";
import { useRouter } from "expo-router";
import * as React from "react";
import { View } from "react-native";
import { ChromePill } from "@/components/ui/chrome-pill";
import { FloatingHeaderScroll } from "@/components/ui/floating-header-scroll";
import { ScreenFrame } from "@/components/ui/screen-frame";
import { ScreenHeader } from "@/components/ui/screen-header";
import { Spinner } from "@/components/ui/spinner";
import { SurfaceGroup, SurfaceRow } from "@/components/ui/surface-card";
import { Text } from "@/components/ui/text";
import { useAtlasSession } from "@/lib/atlas-session";
import { isUnauthorized } from "@/lib/chat-api";
import { fetchUsage } from "@/lib/settings-api";
import { barPercent, costLabel, friendlyError, runsLabel, tokensLabel, USAGE_PERIOD_OPTIONS } from "@/lib/settings-format";
import type { UsageRowView, UsageView } from "@/lib/settings-parse";
import { deviceTimeZone } from "@/lib/timezone";
import { SectionLabel } from "./settings-rows";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; usage: UsageView };

/** Seletor de período: três pílulas lado a lado (a escolhida em destaque). */
function PeriodPicker({ value, onChange }: { value: UsagePeriod; onChange: (period: UsagePeriod) => void }) {
	return (
		<View className="flex-row gap-2" role="radiogroup">
			{USAGE_PERIOD_OPTIONS.map((option) => (
				<ChromePill key={option.value} height={40} label={option.label} onPress={() => onChange(option.value)} className={option.value === value ? "flex-1 justify-center border-foreground bg-foreground/15" : "flex-1 justify-center"}>
					<Text className={option.value === value ? "text-control font-semibold" : "text-control"}>{option.label}</Text>
				</ChromePill>
			))}
		</View>
	);
}

function StatRow({ title, value, hint }: { title: string; value: string; hint?: string }) {
	return (
		<SurfaceRow className="justify-between py-3">
			<View className="min-w-0 flex-1">
				<Text className="text-lg">{title}</Text>
				{hint ? (
					<Text variant="muted" className="text-body">
						{hint}
					</Text>
				) : null}
			</View>
			<Text className="shrink-0 text-lg">{value}</Text>
		</SurfaceRow>
	);
}

/** Linha de uma quebra (bot ou modelo): nome, custo à direita, execuções e uma barra proporcional ao maior da lista. */
function BreakdownRow({ row, rows, label }: { row: UsageRowView; rows: readonly UsageRowView[]; label: string }) {
	const percent = barPercent(row, rows);
	return (
		<SurfaceRow className="flex-col items-stretch justify-center gap-1.5 py-3">
			<View className="flex-row items-center justify-between gap-3">
				<Text numberOfLines={1} className="min-w-0 flex-1 text-control">
					{label}
				</Text>
				<Text className="shrink-0 text-control">{costLabel(row)}</Text>
			</View>
			<View className="h-1.5 overflow-hidden rounded-full bg-foreground/10" accessibilityElementsHidden>
				<View className="h-1.5 rounded-full bg-foreground/60" style={{ width: `${Math.max(percent, row.runs > 0 ? 4 : 0)}%` }} />
			</View>
			<Text variant="muted" className="text-caption">
				{runsLabel(row.runs)}
			</Text>
		</SurfaceRow>
	);
}

function Breakdown({ title, rows, labelOf }: { title: string; rows: readonly UsageRowView[]; labelOf: (row: UsageRowView) => string }) {
	if (rows.length === 0) return null;
	return (
		<>
			<SectionLabel>{title}</SectionLabel>
			<SurfaceGroup>
				{rows.map((row) => (
					<BreakdownRow key={row.key} row={row} rows={rows} label={labelOf(row)} />
				))}
			</SurfaceGroup>
		</>
	);
}

function UsageBody({ usage }: { usage: UsageView }) {
	const { totals } = usage;
	if (totals.runs === 0) {
		return (
			<Text variant="muted" className="px-5 pt-6 text-control">
				Sem uso neste período.
			</Text>
		);
	}
	const tokens = `${tokensLabel(totals.promptTokens)} de entrada, ${tokensLabel(totals.completionTokens)} de saída${totals.cachedTokens > 0 ? `, ${tokensLabel(totals.cachedTokens)} em cache` : ""}`;
	return (
		<>
			<SurfaceGroup className="mt-5">
				<StatRow title="Custo" value={costLabel(totals)} />
				<StatRow title="Execuções" value={String(totals.runs)} />
				<StatRow title="Tokens" value={tokensLabel(totals.promptTokens + totals.completionTokens)} hint={tokens} />
				{totals.planCalls > 0 ? <StatRow title="Chamadas no plano ChatGPT" value={String(totals.planCalls)} /> : null}
			</SurfaceGroup>
			<Breakdown title="Por bot" rows={usage.byBot} labelOf={(row) => row.label} />
			<Breakdown title="Por modelo" rows={usage.byModel} labelOf={(row) => modelDisplayName(undefined, row.label)} />
		</>
	);
}

/** Uso: custo, tokens e execuções do período, com a quebra por bot e por modelo (o que o web mostra, enxuto). */
export function UsageView() {
	const router = useRouter();
	const { apiFetch, signOut } = useAtlasSession();
	const [period, setPeriod] = React.useState<UsagePeriod>("30d");
	const [load, setLoad] = React.useState<Load>({ status: "loading" });
	const [attempt, setAttempt] = React.useState(0);
	React.useEffect(() => {
		let cancelled = false;
		void attempt;
		setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
		fetchUsage(apiFetch, period, deviceTimeZone() ?? "UTC").then(
			(usage) => !cancelled && setLoad({ status: "ready", usage }),
			(reason) => {
				if (cancelled) return;
				if (isUnauthorized(reason)) void signOut();
				else setLoad({ status: "error", message: friendlyError(reason, "load") });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [apiFetch, signOut, period, attempt]);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace("/settings" as never));
	return (
		<ScreenFrame edges={["bottom", "left", "right"]}>
			<FloatingHeaderScroll header={<ScreenHeader title="Uso" onBack={goBack} />} contentContainerClassName="px-4 pb-12">
				<PeriodPicker value={period} onChange={setPeriod} />
				{load.status === "loading" ? (
					<View className="items-center pt-10">
						<Spinner label="Carregando o uso" />
					</View>
				) : null}
				{load.status === "error" ? (
					<View className="items-center gap-3 pt-8">
						<Text className="text-center text-control text-destructive" accessibilityRole="alert">
							{load.message}
						</Text>
						<ChromePill label="Tentar de novo" height={40} onPress={() => setAttempt((value) => value + 1)} className="px-5">
							<Text className="text-control">Tentar de novo</Text>
						</ChromePill>
					</View>
				) : null}
				{load.status === "ready" ? <UsageBody usage={load.usage} /> : null}
			</FloatingHeaderScroll>
		</ScreenFrame>
	);
}
