import {
	DEFAULT_COMMAND_ALLOWLIST,
	DEFAULT_DEV_APPROVAL_MODE,
	DEV_APPROVAL_MODES,
	DEV_APPROVAL_MODE_HELP,
	DEV_APPROVAL_MODE_LABEL,
	addCommandPrefixes,
	DEFAULT_EGRESS_ALLOWLIST,
	DEV_ENV_NETWORK_LABEL,
	DEV_ENV_TIER_LABEL,
	normalizeDomainPattern,
	normalizeEnvRepo,
	parseEnvPaste,
	DEV_ENV_MAX_SECRETS,
	type DevApprovalMode,
	type DevEnvNetwork,
	type DevEnvTier,
} from "@workspace/shared";
import type { DevEnvironmentInput, DevEnvironmentView, DevEnvSuggestionView } from "@/lib/atlas-api";

/** Modelo puro do editor de ambientes de código (Configurações > Conexões). */


export type DevEnvForm = {
	repo: string;
	installCommand: string;
	startCommand: string;
	/** Comando de teste rápido (opcional). */
	testCommand: string;
	tier: DevEnvTier;
	network: DevEnvNetwork;
	domains: string[];
	/** `inherit` = padrão da conta. */
	approvalMode: DevApprovalMode | "inherit";
	commandAllowlist: string[];
	/** Texto estilo .env ("CHAVE=valor" por linha) digitado/colado e ainda não salvo; só existe na memória. */
	secretsText: string;
};

export type DevEnvFormErrors = { repo?: string };

export const EMPTY_DEV_ENV_FORM: DevEnvForm = {
	repo: "",
	installCommand: "",
	startCommand: "",
	testCommand: "",
	tier: "small",
	network: "allowlist",
	domains: [],
	approvalMode: "inherit",
	commandAllowlist: [...DEFAULT_COMMAND_ALLOWLIST],
	secretsText: "",
};

export const TIER_OPTIONS: ReadonlyArray<{ value: DevEnvTier; label: string }> = [
	{ value: "small", label: DEV_ENV_TIER_LABEL.small },
	{ value: "medium", label: DEV_ENV_TIER_LABEL.medium },
	{ value: "large", label: DEV_ENV_TIER_LABEL.large },
];

export const NETWORK_OPTIONS: ReadonlyArray<{ value: DevEnvNetwork; label: string }> = [
	{ value: "allowlist", label: `${DEV_ENV_NETWORK_LABEL.allowlist} (padrão)` },
	{ value: "full", label: DEV_ENV_NETWORK_LABEL.full },
	{ value: "off", label: DEV_ENV_NETWORK_LABEL.off },
];

export const NETWORK_HELP: Record<DevEnvNetwork, string> = {
	allowlist:
		"Só os domínios padrão e os seus (proteção de melhor esforço).",
	full: "Sem restrição de saída para a internet.",
	off: "Lista liberada só na preparação; depois, sem internet.",
};

/** Opções do seletor de aprovação de comandos de um ambiente (a primeira herda a conta). */
export function approvalOptions(accountDefault: DevApprovalMode | null | undefined): ReadonlyArray<{ value: DevApprovalMode | "inherit"; label: string }> {
	const account = accountDefault ?? DEFAULT_DEV_APPROVAL_MODE;
	return [
		{ value: "inherit", label: `Padrão da conta (${DEV_APPROVAL_MODE_LABEL[account]})` },
		...ACCOUNT_APPROVAL_OPTIONS,
	];
}

export const ACCOUNT_APPROVAL_OPTIONS: ReadonlyArray<{ value: DevApprovalMode; label: string }> = DEV_APPROVAL_MODES.map((value) => ({ value, label: value === "auto" ? `${DEV_APPROVAL_MODE_LABEL[value]} (recomendado)` : DEV_APPROVAL_MODE_LABEL[value] }));

export function approvalHelp(mode: DevApprovalMode | "inherit", accountDefault: DevApprovalMode | null | undefined): string {
	return DEV_APPROVAL_MODE_HELP[mode === "inherit" ? (accountDefault ?? DEFAULT_DEV_APPROVAL_MODE) : mode];
}

/** A lista de comandos liberados só vale no modo "Lista liberada" (próprio ou herdado da conta). */
export function showsCommandAllowlist(mode: DevApprovalMode | "inherit", accountDefault: DevApprovalMode | null | undefined): boolean {
	// Lista liberada e Automático usam a lista (no Automático ela dispensa o Verificador; "Sempre neste repositório" grava aqui).
	return (mode === "inherit" ? (accountDefault ?? DEFAULT_DEV_APPROVAL_MODE) : mode) !== "ask";
}

export { addCommandPrefixes };

export const TEST_COMMAND_HELP = "O bot usa este comando para testar. Ex.: pnpm --filter @app/api test";

export const SECRETS_HELP = "Cole o conteúdo de um .env (CHAVE=valor, um por linha). Criptografados; nunca voltam para a tela.";

export function formFromEnvironment(env: DevEnvironmentView): DevEnvForm {
	return {
		repo: env.repo,
		installCommand: env.installCommand ?? "",
		startCommand: env.startCommand ?? "",
		testCommand: env.testCommand ?? "",
		tier: env.tier,
		network: env.network,
		domains: [...env.allowlist],
		approvalMode: env.approvalMode ?? "inherit",
		commandAllowlist: [...env.commandAllowlist],
		secretsText: "",
	};
}

export function inputFromForm(form: DevEnvForm): DevEnvironmentInput {
	return {
		repo: normalizeEnvRepo(form.repo) ?? form.repo.trim(),
		installCommand: form.installCommand.trim() || null,
		startCommand: form.startCommand.trim() || null,
		testCommand: form.testCommand.trim() || null,
		tier: form.tier,
		network: form.network,
		allowlist: form.domains,
		approvalMode: form.approvalMode === "inherit" ? null : form.approvalMode,
		commandAllowlist: form.commandAllowlist,
	};
}

export function validateEnvForm(
	form: DevEnvForm,
	others: readonly DevEnvironmentView[],
	editingId: string | null,
): { ok: true } | { ok: false; errors: DevEnvFormErrors } {
	const repo = normalizeEnvRepo(form.repo);
	if (!repo) return { ok: false, errors: { repo: "Use o formato dono/nome, como acme/site." } };
	if (others.some((env) => env.repo === repo && env.id !== editingId)) {
		return { ok: false, errors: { repo: "Já existe um ambiente para este repositório." } };
	}
	return { ok: true };
}

export function isEnvFormDirty(initial: DevEnvForm, current: DevEnvForm): boolean {
	return JSON.stringify(initial) !== JSON.stringify(current);
}

/** Separa o texto digitado (vírgula, espaço ou quebra de linha) em domínios válidos e inválidos. */
export function parseDomainInput(text: string): { valid: string[]; invalid: string[] } {
	const valid: string[] = [];
	const invalid: string[] = [];
	for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
		const domain = normalizeDomainPattern(part);
		if (domain) {
			if (!valid.includes(domain)) valid.push(domain);
		} else {
			invalid.push(part);
		}
	}
	return { valid, invalid };
}

export function addDomains(current: readonly string[], text: string): { domains: string[]; error: string | null } {
	const { valid, invalid } = parseDomainInput(text);
	const domains = [...current];
	for (const domain of valid) {
		if (!domains.includes(domain) && !DEFAULT_EGRESS_ALLOWLIST.includes(domain)) domains.push(domain);
	}
	return { domains, error: invalid.length ? `Domínio inválido: ${invalid[0]}` : null };
}

// ----- segredos (texto estilo .env) -----

export type SecretsTextAnalysis = {
	entries: { name: string; value: string }[];
	/** Mensagens por linha ("linha 3: falta '='"). */
	errors: string[];
	/** Nomes digitados que já estão definidos (serão substituídos). */
	overwrites: string[];
};

export function analyzeSecretsText(text: string, existingNames: readonly string[]): SecretsTextAnalysis {
	const parsed = parseEnvPaste(text);
	const entries = parsed.entries.map(({ name, value }) => ({ name, value }));
	return { entries, errors: parsed.errors.map((error) => error.message), overwrites: entries.map((entry) => entry.name).filter((name) => existingNames.includes(name)) };
}

/** Erro de limite: segredos novos + já salvos (sem contar os que serão sobrescritos). */
export function secretLimitError(entryNames: readonly string[], existingNames: readonly string[]): string | null {
	const total = new Set([...existingNames, ...entryNames]).size;
	return total > DEV_ENV_MAX_SECRETS ? `No máximo ${DEV_ENV_MAX_SECRETS} segredos por ambiente` : null;
}

export function savedSecretsLabel(count: number): string {
	return count === 1 ? "1 segredo salvo" : `${count} segredos salvos`;
}

// ----- preenchimento a partir do repositório -----

export type SuggestionTouched = ReadonlySet<"installCommand" | "startCommand" | "testCommand" | "tier" | "commandAllowlist">;

/** Aplica a sugestão só nos campos que o usuário ainda não mexeu. */
export function applySuggestion(form: DevEnvForm, suggestion: DevEnvSuggestionView, touched: SuggestionTouched): { form: DevEnvForm; filled: boolean } {
	if (!suggestion.detected) return { form, filled: false };
	const next: DevEnvForm = { ...form };
	let filled = false;
	if (!touched.has("installCommand") && !form.installCommand.trim() && suggestion.installCommand) {
		next.installCommand = suggestion.installCommand;
		filled = true;
	}
	if (!touched.has("startCommand") && !form.startCommand.trim() && suggestion.startCommand) {
		next.startCommand = suggestion.startCommand;
		filled = true;
	}
	if (!touched.has("testCommand") && !form.testCommand.trim() && suggestion.testCommand) {
		next.testCommand = suggestion.testCommand;
		filled = true;
	}
	if (!touched.has("tier") && form.tier === "small" && suggestion.tier && suggestion.tier !== "small") {
		next.tier = suggestion.tier;
		filled = true;
	}
	const isDefaultList = form.commandAllowlist.length === DEFAULT_COMMAND_ALLOWLIST.length && DEFAULT_COMMAND_ALLOWLIST.every((item) => form.commandAllowlist.includes(item));
	if (!touched.has("commandAllowlist") && isDefaultList && suggestion.commandAllowlist && suggestion.commandAllowlist.length > 0) {
		next.commandAllowlist = [...suggestion.commandAllowlist];
		filled = true;
	}
	return { form: next, filled };
}

/** "Pequeno · 1 GB · Lista liberada" */
export function envSummary(env: Pick<DevEnvironmentView, "tier" | "network" | "secrets"> & { approvalMode?: DevApprovalMode | null }): string {
	const parts: string[] = [DEV_ENV_TIER_LABEL[env.tier], DEV_ENV_NETWORK_LABEL[env.network]];
	if (env.approvalMode) parts.push(`Comandos: ${DEV_APPROVAL_MODE_LABEL[env.approvalMode]}`);
	if (env.secrets.length > 0) parts.push(env.secrets.length === 1 ? "1 segredo" : `${env.secrets.length} segredos`);
	return parts.join(" · ");
}

export function environmentsHint(count: number | undefined): string | null {
	if (!count) return null;
	return count === 1 ? "1 ambiente de código" : `${count} ambientes de código`;
}

/** Sugestões de repositório da conexão GitHub, sem os que já têm ambiente. */
export function suggestRepos(
	options: ReadonlyArray<{ fullName: string }>,
	query: string,
	taken: readonly string[],
	limit = 8,
): string[] {
	const q = query.trim().toLowerCase();
	return options
		.map((option) => option.fullName)
		.filter((name) => !taken.includes(name.toLowerCase()) && (!q || name.toLowerCase().includes(q)))
		.slice(0, limit);
}

export function envErrorMessage(cause: unknown): string {
	return cause instanceof Error && cause.message ? cause.message : "Não foi possível concluir. Tente novamente.";
}

