"use client";

import {
	ActivityIcon,
	AlertTriangleIcon,
	BellIcon,
	CpuIcon,
	DatabaseIcon,
	KeyRoundIcon,
	LayersIcon,
	ListChecksIcon,
	RefreshCwIcon,
	ServerIcon,
	TagIcon,
} from "lucide-react";
import type { DiagnosticsView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { useDiagnostics } from "@/hooks/use-diagnostics";
import { SettingRow, SettingsGroup } from "../setting-row";
import {
	checkLabel,
	commitLabel,
	failureKindLabel,
	maintenanceJobLabel,
	maintenanceSuccessLabel,
	maintenanceTime,
	missingFeaturesLabel,
	queuesLabel,
	uptimeLabel,
	versionFooter,
	versionMismatch,
	webCommitShort,
	webVersion,
} from "../diagnostics-state";
import { formatDateTime, formatTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/provider";

const statusClass = (ok: boolean) => (ok ? "text-foreground" : "text-destructive");

/** Diagnóstico: versões, saúde dos serviços, push, chaves (sim/não) e últimas falhas. Só leitura. */
export function DiagnosticsSettingsView({
	data,
	loading,
	error,
	onRefresh,
	webCommit,
	webVersion: webVersionText = null,
	isVisible = () => true,
}: {
	data: DiagnosticsView | null;
	loading: boolean;
	error: string | null;
	onRefresh: () => void;
	webCommit: string | null;
	webVersion?: string | null;
	isVisible?: (itemId: string) => boolean;
}) {
	const translator = useTranslations();
	const { t, locale } = translator;
	if (!isVisible("avancado.diagnostico")) return null;
	const mismatch = data ? versionMismatch(data, webCommit) : false;
	return (
		<>
			<SettingsGroup title={t("settings.diag.serverGroup")}>
				<SettingRow
					caption={error ? <p className="text-destructive" role="alert">{error}</p> : data ? <p>{t("settings.diag.updatedAt", { time: formatTime(data.generatedAt, locale) })}</p> : null}
					control="inline"
					description={t("settings.diag.serverStateHint")}
					icon={ActivityIcon}
					label={t("settings.diag.serverState")}
				>
					<Button disabled={loading} onClick={onRefresh} size="sm" variant="outline">
						<RefreshCwIcon aria-hidden className={loading ? "motion-safe:animate-spin" : undefined} />
						{t("settings.diag.refresh")}
					</Button>
				</SettingRow>
				{data ? (
					<>
						<SettingRow
							caption={mismatch ? <p className="text-destructive">{t("settings.diag.mismatch")}</p> : null}
							control="inline"
							icon={TagIcon}
							label="API"
						>
							<span data-slot="diag-api">{`${commitLabel(data.api.commitShort) ? `${commitLabel(data.api.commitShort)} · ` : ""}${t("settings.diag.apiUp", { uptime: uptimeLabel(data.api.uptimeSec, translator) })}`}</span>
						</SettingRow>
						<SettingRow control="inline" icon={CpuIcon} label="Worker">
							<span className={statusClass(data.worker.up)} data-slot="diag-worker">
								{data.worker.up ? `${commitLabel(data.worker.commitShort) ? `${commitLabel(data.worker.commitShort)} · ` : ""}${t("settings.diag.workerUp")}` : t("settings.diag.workerDown")}
							</span>
						</SettingRow>
						<SettingRow control="inline" icon={ServerIcon} label="Web">
							<span data-slot="diag-web">{[webVersionText, commitLabel(webCommit)].filter(Boolean).join(" · ") || t("settings.diag.webUp")}</span>
						</SettingRow>
					</>
				) : null}
			</SettingsGroup>
			{data ? (
				<>
					<SettingsGroup title={t("settings.diag.servicesGroup")}>
						<SettingRow control="inline" icon={DatabaseIcon} label="Postgres">
							<span className={statusClass(data.services.postgres.ok)}>{checkLabel(data.services.postgres, translator)}</span>
						</SettingRow>
						<SettingRow control="inline" icon={DatabaseIcon} label="Redis">
							<span className={statusClass(data.services.redis.ok)}>{checkLabel(data.services.redis, translator)}</span>
						</SettingRow>
						<SettingRow control="inline" icon={LayersIcon} label={t("settings.diag.queue")}>
							<span>{queuesLabel(data.services.queues, translator)}</span>
						</SettingRow>
						<SettingRow control="inline" icon={BellIcon} label={t("settings.diag.push")}>
							<span className={statusClass(data.push.enabled)}>
								{data.push.enabled ? translator.tn("settings.diag.pushOn", data.push.subscriptions) : t("settings.diag.pushOff")}
							</span>
						</SettingRow>
						<SettingRow control="inline" icon={AlertTriangleIcon} label="Sentry">
							<span>{data.sentry.enabled ? t("settings.diag.sentryOn") : t("settings.diag.sentryOff")}</span>
						</SettingRow>
					</SettingsGroup>
					<SettingsGroup title={t("settings.diag.keysGroup")}>
						{data.providers.map((provider) => (
							<SettingRow control="inline" icon={KeyRoundIcon} key={provider.id} label={provider.label}>
								<span className={provider.present ? "text-foreground" : "text-muted-foreground"}>
									{provider.present ? (provider.source === "server" ? t("settings.diag.keyPresentServer") : t("settings.diag.keyPresent")) : t("settings.diag.keyAbsent")}
								</span>
							</SettingRow>
						))}
						<SettingRow control="inline" icon={ServerIcon} label={t("settings.diag.serverFeatures")}>
							<span className="text-right text-muted-foreground">{missingFeaturesLabel(data.env, translator)}</span>
						</SettingRow>
					</SettingsGroup>
					{(data.maintenance?.length ?? 0) > 0 ? (
					<SettingsGroup title={t("settings.diag.tasksGroup")}>
						{(data.maintenance ?? []).map((job) => (
							<SettingRow
								caption={
									job.lastError ? (
										<p className="text-destructive" data-slot="diag-maintenance-error">{t("settings.diag.lastError", { time: maintenanceTime(job.lastError.at, locale), message: job.lastError.message })}</p>
									) : null
								}
								control="inline"
								icon={ListChecksIcon}
								key={job.kind}
								label={maintenanceJobLabel(job.kind, translator)}
							>
								<span className={job.lastSuccessAt ? "text-foreground" : "text-muted-foreground"} data-slot="diag-maintenance-success">
									{maintenanceSuccessLabel(job.lastSuccessAt, translator)}
								</span>
							</SettingRow>
						))}
					</SettingsGroup>
					) : null}
					<SettingsGroup title={t("settings.diag.failuresGroup")}>
						{data.failures.length === 0 ? (
							<SettingRow control="inline" icon={AlertTriangleIcon} label={t("settings.diag.noFailures")} />
						) : (
							data.failures.map((failure) => (
								<SettingRow
									caption={<p>{failure.reason}</p>}
									control="inline"
									icon={AlertTriangleIcon}
									key={`${failure.kind}-${failure.id}`}
									label={`${failureKindLabel(failure.kind, translator)} · ${failure.label}`}
								>
									<span className="text-xs text-muted-foreground">
										{formatDateTime(failure.at, locale)}
									</span>
								</SettingRow>
							))
						)}
					</SettingsGroup>
					<p className="px-2 text-xs text-muted-foreground" data-slot="diag-version-footer">
						{versionFooter(webVersionText ?? data.api.version, webCommit ?? data.api.commitShort, translator)}
					</p>
				</>
			) : null}
		</>
	);
}

export function DiagnosticsSettings({ isVisible }: { isVisible?: (itemId: string) => boolean }) {
	const { data, loading, error, refresh } = useDiagnostics(isVisible ? isVisible("avancado.diagnostico") : true);
	return <DiagnosticsSettingsView data={data} error={error} isVisible={isVisible} loading={loading} onRefresh={refresh} webCommit={webCommitShort()} webVersion={webVersion()} />;
}
