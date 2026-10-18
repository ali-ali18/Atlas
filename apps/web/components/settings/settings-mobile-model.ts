import type { SettingsNavId } from "./settings-registry";

/** Modelo puro da lista mobile: grupos de linhas, cada uma levando a uma seção. */
export type MobileSettingsRow = { id: SettingsNavId; title: string; secondary: string };
export type MobileSettingsGroup = { id: string; rows: MobileSettingsRow[] };

export type MobileSettingsSummary = {
	theme?: string;
	defaultModel?: string;
	chatgptEnabled?: boolean;
	/** Navegador do agente liga sozinho (`sandboxAutoStart`); `undefined` = ainda carregando. */
	browserAuto?: boolean;
	/** Conexões ativas (Composio + MCP); `undefined` = ainda carregando. */
	connectionsCount?: number;
	/** Ambientes de código salvos; `undefined` = ainda carregando. */
	environmentsCount?: number;
	/** Habilidades da conta; `undefined` = ainda carregando. */
	skillsCount?: number;
	/** Custo do período em US$; `null` = sem custo informado; `undefined` = carregando. */
	usageCostUsd?: number | null;
	/** Revisão (JEV): `on` se algum recurso está ligado, `shadow` se só em teste. */
	reviewMode?: "off" | "shadow" | "on";
};

/** Janela do custo mostrado na lista: a mesma que a seção Uso abre por padrão. */
export const MOBILE_USAGE_WINDOW_LABEL = "últimos 7 dias";

const brl = (value: number, digits: number) =>
	value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function connectionsHint(count: number | undefined): string {
	return count === undefined ? "Conectores e MCP" : count === 0 ? "Nenhuma conexão" : count === 1 ? "1 conectado" : `${count} conectados`;
}

export function skillsHint(count: number | undefined): string {
	return count === undefined ? "Procedimentos do agente" : count === 0 ? "Nenhuma habilidade" : count === 1 ? "1 habilidade" : `${count} habilidades`;
}

/** Computador: navegador do agente e, se houver, quantos ambientes de código. */
export function computerHint(browserAuto: boolean | undefined, environments: number | undefined): string {
	const envs = environments ? (environments === 1 ? "1 ambiente" : `${environments} ambientes`) : null;
	if (!envs) return browserAuto === undefined ? "Navegador e ambientes de código" : browserAuto ? "Navegador: automático" : "Navegador: manual";
	return `${browserAuto === undefined ? "Navegador" : browserAuto ? "Automático" : "Manual"} · ${envs}`;
}

export function usageHint(cost: number | null | undefined): string {
	if (cost === undefined || cost === null) return "Consumo e gastos";
	const text = cost > 0 && cost < 0.01 ? brl(cost, 4) : brl(cost, 2);
	return `US$ ${text} nos ${MOBILE_USAGE_WINDOW_LABEL}`;
}

export function reviewHint(mode: MobileSettingsSummary["reviewMode"]): string {
	if (mode === "on") return "Revisão JEV ligada";
	if (mode === "shadow") return "Revisão JEV em teste";
	if (mode === "off") return "Revisão desligada";
	return "Revisão e limites de execução";
}

/** Título de cada página no mobile (pode diferir do rótulo curto da nav do desktop). */
export const MOBILE_TITLES: Record<SettingsNavId, string> = {
	conta: "Conta",
	geral: "Geral",
	provedores: "Provedores e assinaturas",
	bots: "Bots",
	notificacoes: "Notificações",
	computador: "Computador",
	conexoes: "Conexões",
	cofre: "Cofre",
	habilidades: "Habilidades",
	uso: "Uso e custos",
	avancado: "Avançado",
};

/** As mesmas seções do desktop (Conta fica no cartão de perfil do topo); Avançado fica sempre por último, separado. */
export function mobileSettingsGroups(
	summary: MobileSettingsSummary,
	hidden: ReadonlySet<SettingsNavId> = new Set(),
): MobileSettingsGroup[] {
	const row = (id: SettingsNavId, secondary: string): MobileSettingsRow => ({
		id,
		title: MOBILE_TITLES[id],
		secondary,
	});
	const geralHint = summary.theme ? `Tema ${summary.theme.toLocaleLowerCase("pt-BR")}` : "Tema, idioma e fuso";
	const provedoresHint = [summary.chatgptEnabled ? "ChatGPT" : null, summary.defaultModel ?? null].filter(Boolean).join(" · ");
	const groups: MobileSettingsGroup[] = [
		{
			id: "principal",
			rows: [
				row("geral", geralHint),
				row("provedores", provedoresHint || "Planos, chaves e modelos"),
				row("bots", "Autonomia, grupos e reflexão"),
				row("notificacoes", "Avisos no celular"),
			],
		},
		{
			id: "ambiente",
			rows: [
				row("computador", computerHint(summary.browserAuto, summary.environmentsCount)),
				row("conexoes", connectionsHint(summary.connectionsCount)),
				row("cofre", "Senhas, chaves e logins"),
				row("habilidades", skillsHint(summary.skillsCount)),
				row("uso", usageHint(summary.usageCostUsd)),
			],
		},
		{
			id: "avancado",
			rows: [row("avancado", reviewHint(summary.reviewMode))],
		},
	];
	return groups
		.map((group) => ({ ...group, rows: group.rows.filter((r) => !hidden.has(r.id)) }))
		.filter((group) => group.rows.length > 0);
}
