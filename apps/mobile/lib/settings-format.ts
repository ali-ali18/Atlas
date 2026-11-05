// Textos e contas puras das Configurações (custo, tokens, níveis de permissão, idioma, avisos de erro). Sem React.
import { AUTONOMY_LEVELS, AUTONOMY_LEVEL_DESCRIPTIONS, AUTONOMY_LEVEL_LABELS, type AutonomyLevel, type UsagePeriod, USAGE_PERIODS } from "@workspace/shared";
import { ChatApiError, isNetworkError } from "./chat-api";
import type { UsageRowView, UsageTotalsView } from "./settings-parse";

const decimal = (value: number, digits: number): string => value.toFixed(digits).replace(".", ",");

/** "US$ 12,35" a partir de 1 dólar e "US$ 0,0042" abaixo disso (as chamadas pequenas custam frações de centavo). */
export function formatUsd(value: number): string {
	return `US$ ${value >= 1 ? decimal(value, 2) : decimal(value, 4)}`;
}

/** Custo para a linha "Uso" e para os totais: "—" sem nenhum custo informado e "(parcial)" quando faltou o de alguma chamada. */
export function costLabel(totals: Pick<UsageTotalsView, "costUsd" | "costUnknownCalls" | "planCalls">): string {
	if (totals.costUsd === null) return totals.planCalls > 0 ? "Plano" : "—";
	return totals.costUnknownCalls > 0 ? `${formatUsd(totals.costUsd)} (parcial)` : formatUsd(totals.costUsd);
}

/** "1,2 mil", "3,4 mi": tokens curtos para caber numa linha. Sem `Intl` compacto (nem todo motor do celular tem). */
export function tokensLabel(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "0";
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${decimal(tokens / 1000, 1).replace(/,0$/, "")} mil`;
	return `${decimal(tokens / 1_000_000, 1).replace(/,0$/, "")} mi`;
}

export const runsLabel = (runs: number): string => (runs === 1 ? "1 execução" : `${runs} execuções`);

const PERIOD_LABELS: Record<UsagePeriod, string> = { today: "Hoje", "7d": "7 dias", "30d": "30 dias" };

export const USAGE_PERIOD_OPTIONS: readonly { value: UsagePeriod; label: string }[] = USAGE_PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }));

/** Período do número que aparece na linha "Uso" do menu principal. */
export const SUMMARY_USAGE_PERIOD: UsagePeriod = "30d";

/** Largura da barra (0 a 100) da linha em relação à maior da lista: por custo quando há custo, senão por execuções. */
export function barPercent(row: Pick<UsageRowView, "costUsd" | "runs">, rows: readonly Pick<UsageRowView, "costUsd" | "runs">[]): number {
	const maxCost = Math.max(0, ...rows.map((item) => item.costUsd ?? 0));
	if (maxCost > 0) return Math.round(((row.costUsd ?? 0) / maxCost) * 100);
	const maxRuns = Math.max(0, ...rows.map((item) => item.runs));
	return maxRuns > 0 ? Math.round((row.runs / maxRuns) * 100) : 0;
}

/** Níveis de permissão na ordem do servidor, com o texto do web (`AUTONOMY_LEVEL_*` de shared). */
export const AUTONOMY_OPTIONS: readonly { value: AutonomyLevel; label: string; description: string }[] = AUTONOMY_LEVELS.map((value) => ({ value, label: AUTONOMY_LEVEL_LABELS[value], description: AUTONOMY_LEVEL_DESCRIPTIONS[value] }));

/** Subtítulo da linha "Permissões": o nível que vale; ainda sem ler, não inventa um. */
export function autonomySubtitle(level: AutonomyLevel | null): string {
	return level ? AUTONOMY_LEVEL_LABELS[level] : "Carregando…";
}

/**
 * Aviso amigável quando salvar ou carregar falha: sem rede, sessão caída ou recusa do servidor. Nunca mostra status HTTP
 * nem texto técnico; a mensagem do servidor só entra quando ele mesmo a escreveu (já em pt-BR e voltada ao usuário).
 */
export function friendlyError(error: unknown, action: "save" | "load" = "save"): string {
	const verb = action === "save" ? "salvar" : "carregar";
	if (isNetworkError(error)) return `Sem conexão. Não consegui ${verb} agora.`;
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.fromServer && error.status < 500) return error.message;
	}
	return `Não consegui ${verb} agora. Tente de novo.`;
}

/** Rodapé: "Versão 0.0.1" e, quando há atualização instalada, o início do id dela ("0.0.1 (a1b2c3d)"). */
export function versionLabel(version: string | null | undefined, updateId: string | null | undefined): string {
	const base = version?.trim() ? version.trim() : null;
	const update = updateId?.trim() ? updateId.trim().slice(0, 7) : null;
	if (base && update) return `${base} (${update})`;
	return base ?? update ?? "";
}
