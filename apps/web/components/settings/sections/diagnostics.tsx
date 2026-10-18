"use client";

import {
	ActivityIcon,
	AlertTriangleIcon,
	BellIcon,
	CpuIcon,
	DatabaseIcon,
	KeyRoundIcon,
	LayersIcon,
	RefreshCwIcon,
	ServerIcon,
	TagIcon,
} from "lucide-react";
import type { DiagnosticsView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { useDiagnostics } from "@/hooks/use-diagnostics";
import { SettingRow, SettingsGroup } from "../setting-row";
import {
	FAILURE_KIND_LABEL,
	checkLabel,
	commitLabel,
	missingFeaturesLabel,
	queuesLabel,
	uptimeLabel,
	versionFooter,
	versionMismatch,
	webCommitShort,
	webVersion,
} from "../diagnostics-state";

const statusClass = (ok: boolean) => (ok ? "text-foreground" : "text-destructive");

/** Avançado: versões, saúde dos serviços, push, chaves (sim/não) e últimas falhas. Só leitura. */
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
	if (!isVisible("avancado.diagnostico")) return null;
	const mismatch = data ? versionMismatch(data, webCommit) : false;
	return (
		<>
			<SettingsGroup title="Diagnóstico">
				<SettingRow
					caption={error ? <p className="text-destructive" role="alert">{error}</p> : data ? <p>{`Atualizado às ${new Date(data.generatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`}</p> : null}
					control="inline"
					description="Só leitura. Mostra o estado do servidor sem expor valores de chaves."
					icon={ActivityIcon}
					label="Estado do servidor"
				>
					<Button disabled={loading} onClick={onRefresh} size="sm" variant="outline">
						<RefreshCwIcon aria-hidden className={loading ? "animate-spin" : undefined} />
						Atualizar
					</Button>
				</SettingRow>
			</SettingsGroup>
			{data ? (
				<>
					<SettingsGroup title="Versões">
						<SettingRow
							caption={mismatch ? <p className="text-destructive">Versões diferentes: o deploy pode ter ficado pela metade.</p> : null}
							control="inline"
							icon={TagIcon}
							label="API"
						>
							<span data-slot="diag-api">{`${commitLabel(data.api.commitShort) ? `${commitLabel(data.api.commitShort)} · ` : ""}ligada há ${uptimeLabel(data.api.uptimeSec)}`}</span>
						</SettingRow>
						<SettingRow control="inline" icon={CpuIcon} label="Worker">
							<span className={statusClass(data.worker.up)} data-slot="diag-worker">
								{data.worker.up ? `${commitLabel(data.worker.commitShort) ? `${commitLabel(data.worker.commitShort)} · ` : ""}ativo` : "sem sinal (parado ou sem Redis)"}
							</span>
						</SettingRow>
						<SettingRow control="inline" icon={ServerIcon} label="Web">
							<span data-slot="diag-web">{[webVersionText, commitLabel(webCommit)].filter(Boolean).join(" · ") || "ativo"}</span>
						</SettingRow>
					</SettingsGroup>
					<SettingsGroup title="Serviços">
						<SettingRow control="inline" icon={DatabaseIcon} label="Postgres">
							<span className={statusClass(data.services.postgres.ok)}>{checkLabel(data.services.postgres)}</span>
						</SettingRow>
						<SettingRow control="inline" icon={DatabaseIcon} label="Redis">
							<span className={statusClass(data.services.redis.ok)}>{checkLabel(data.services.redis)}</span>
						</SettingRow>
						<SettingRow control="inline" icon={LayersIcon} label="Fila">
							<span>{queuesLabel(data.services.queues)}</span>
						</SettingRow>
						<SettingRow control="inline" icon={BellIcon} label="Notificações push">
							<span className={statusClass(data.push.enabled)}>
								{data.push.enabled ? `ligadas · ${data.push.subscriptions} aparelho${data.push.subscriptions === 1 ? "" : "s"}` : "desligadas no servidor"}
							</span>
						</SettingRow>
						<SettingRow control="inline" icon={AlertTriangleIcon} label="Sentry">
							<span>{data.sentry.enabled ? "ligado" : "desligado"}</span>
						</SettingRow>
					</SettingsGroup>
					<SettingsGroup title="Chaves e provedores">
						{data.providers.map((provider) => (
							<SettingRow control="inline" icon={KeyRoundIcon} key={provider.id} label={provider.label}>
								<span className={provider.present ? "text-foreground" : "text-muted-foreground"}>
									{provider.present ? (provider.source === "server" ? "presente (servidor)" : "presente") : "ausente"}
								</span>
							</SettingRow>
						))}
						<SettingRow control="inline" icon={ServerIcon} label="Recursos do servidor">
							<span className="text-right text-muted-foreground">{missingFeaturesLabel(data.env)}</span>
						</SettingRow>
					</SettingsGroup>
					<SettingsGroup title="Últimas falhas">
						{data.failures.length === 0 ? (
							<SettingRow control="inline" icon={AlertTriangleIcon} label="Nenhuma falha recente" />
						) : (
							data.failures.map((failure) => (
								<SettingRow
									caption={<p>{failure.reason}</p>}
									control="inline"
									icon={AlertTriangleIcon}
									key={`${failure.kind}-${failure.id}`}
									label={`${FAILURE_KIND_LABEL[failure.kind]} · ${failure.label}`}
								>
									<span className="text-xs text-muted-foreground">
										{new Date(failure.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
									</span>
								</SettingRow>
							))
						)}
					</SettingsGroup>
					<p className="px-2 text-xs text-muted-foreground" data-slot="diag-version-footer">
						{versionFooter(webVersionText ?? data.api.version, webCommit ?? data.api.commitShort)}
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
