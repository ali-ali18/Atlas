import {
	DEFAULT_COMMAND_ALLOWLIST,
	DEFAULT_DEV_APPROVAL_MODE,
	DEV_APPROVAL_MODES,
	addCommandPrefixes,
	DEFAULT_EGRESS_ALLOWLIST,
	normalizeDomainPattern,
	normalizeEnvRepo,
	parseEnvPaste,
	DEV_ENV_MAX_SECRETS,
	type DevApprovalMode,
	type DevEnvNetwork,
	type DevEnvTier,
} from "@workspace/shared";
import { getActiveTranslator } from "@/lib/i18n/active";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { devApprovalModeHelp, devApprovalModeLabel, devEnvNetworkLabel, devEnvTierLabel } from "@/lib/shared-labels";
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

export function tierOptions(translator: Translator = defaultTranslator): ReadonlyArray<{ value: DevEnvTier; label: string }> {
	return (["small", "medium", "large"] as const).map((value) => ({ value, label: devEnvTierLabel(value, translator) }));
}

export function networkOptions(translator: Translator = defaultTranslator): ReadonlyArray<{ value: DevEnvNetwork; label: string }> {
	return [
		{ value: "allowlist", label: translator.t("settings.dev.networkDefault", { label: devEnvNetworkLabel("allowlist", translator) }) },
		{ value: "full", label: devEnvNetworkLabel("full", translator) },
		{ value: "off", label: devEnvNetworkLabel("off", translator) },
	];
}

export function networkHelp(network: DevEnvNetwork, { t }: Translator = defaultTranslator): string {
	return t(({ allowlist: "settings.dev.netHelp.allowlist", full: "settings.dev.netHelp.full", off: "settings.dev.netHelp.off" } as const)[network]);
}

/** Opções do seletor de aprovação de comandos de um ambiente (a primeira herda a conta). */
export function approvalOptions(
	accountDefault: DevApprovalMode | null | undefined,
	translator: Translator = defaultTranslator,
): ReadonlyArray<{ value: DevApprovalMode | "inherit"; label: string }> {
	const account = accountDefault ?? DEFAULT_DEV_APPROVAL_MODE;
	return [
		{ value: "inherit", label: translator.t("settings.dev.approvalInherit", { mode: devApprovalModeLabel(account, translator) }) },
		...accountApprovalOptions(translator),
	];
}

export function accountApprovalOptions(translator: Translator = defaultTranslator): ReadonlyArray<{ value: DevApprovalMode; label: string }> {
	return DEV_APPROVAL_MODES.map((value) => ({
		value,
		label: value === "auto" ? translator.t("settings.dev.recommended", { label: devApprovalModeLabel(value, translator) }) : devApprovalModeLabel(value, translator),
	}));
}

export function approvalHelp(mode: DevApprovalMode | "inherit", accountDefault: DevApprovalMode | null | undefined, translator: Translator = defaultTranslator): string {
	return devApprovalModeHelp(mode === "inherit" ? (accountDefault ?? DEFAULT_DEV_APPROVAL_MODE) : mode, translator);
}

/** A lista de comandos liberados só vale no modo "Lista liberada" (próprio ou herdado da conta). */
export function showsCommandAllowlist(mode: DevApprovalMode | "inherit", accountDefault: DevApprovalMode | null | undefined): boolean {
	// Lista liberada e Automático usam a lista (no Automático ela dispensa o Verificador; "Sempre neste repositório" grava aqui).
	return (mode === "inherit" ? (accountDefault ?? DEFAULT_DEV_APPROVAL_MODE) : mode) !== "ask";
}

export { addCommandPrefixes };

export const testCommandHelp = ({ t }: Translator = defaultTranslator): string => t("settings.dev.testCommandHelp");

export const secretsHelp = ({ t }: Translator = defaultTranslator): string => t("settings.dev.secretsHelp");

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
	{ t }: Translator = defaultTranslator,
): { ok: true } | { ok: false; errors: DevEnvFormErrors } {
	const repo = normalizeEnvRepo(form.repo);
	if (!repo) return { ok: false, errors: { repo: t("settings.dev.err.repoFormat") } };
	if (others.some((env) => env.repo === repo && env.id !== editingId)) {
		return { ok: false, errors: { repo: t("settings.dev.err.repoDuplicate") } };
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

export function addDomains(current: readonly string[], text: string, { t }: Translator = defaultTranslator): { domains: string[]; error: string | null } {
	const { valid, invalid } = parseDomainInput(text);
	const domains = [...current];
	for (const domain of valid) {
		if (!domains.includes(domain) && !DEFAULT_EGRESS_ALLOWLIST.includes(domain)) domains.push(domain);
	}
	return { domains, error: invalid.length ? t("settings.dev.err.invalidDomain", { domain: invalid[0]! }) : null };
}

// ----- segredos (texto estilo .env) -----

export type SecretsTextAnalysis = {
	entries: { name: string; value: string }[];
	/** Mensagens por linha ("linha 3: falta '='"). */
	errors: string[];
	/** Nomes digitados que já estão definidos (serão substituídos). */
	overwrites: string[];
};

/** As mensagens do parser de `.env` vêm de `shared` em pt-BR: reconhece cada uma e devolve no idioma da tela. */
export function translateSecretError(message: string, { t }: Translator = defaultTranslator): string {
	const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
		[/^linha (\d+): falta '='$/, (m) => t("settings.dev.paste.missingEquals", { line: m[1]! })],
		[/^linha (\d+): falta o nome antes do '='$/, (m) => t("settings.dev.paste.missingName", { line: m[1]! })],
		[/^linha (\d+): o nome (.*)\.\.\. passa de 64 caracteres$/, (m) => t("settings.dev.paste.nameTooLong", { line: m[1]!, name: m[2]! })],
		[/^linha (\d+): o nome (.*) não pode começar com número$/, (m) => t("settings.dev.paste.nameDigit", { line: m[1]!, name: m[2]! })],
		[/^linha (\d+): o nome (.*) tem caractere inválido \(use A-Z, 0-9 e _\)$/, (m) => t("settings.dev.paste.nameInvalid", { line: m[1]!, name: m[2]! })],
		[/^linha (\d+): o nome (.*) é reservado$/, (m) => t("settings.dev.paste.nameReserved", { line: m[1]!, name: m[2]! })],
		[/^linha (\d+): faltou fechar as aspas de (.*)$/, (m) => t("settings.dev.paste.quote", { line: m[1]!, name: m[2]! })],
		[/^linha (\d+): o valor de (.*) é grande demais$/, (m) => t("settings.dev.paste.tooBig", { line: m[1]!, name: m[2]! })],
	];
	for (const [pattern, render] of patterns) {
		const match = message.match(pattern);
		if (match) return render(match);
	}
	return message;
}

/** Erro de `addCommandPrefixes` (shared, pt-BR) no idioma da tela. */
export function translateCommandError(message: string | null, { t }: Translator = defaultTranslator): string | null {
	const match = message?.match(/^Comando inválido: (.*)$/s);
	return match ? t("settings.dev.err.invalidCommand", { command: match[1]! }) : message;
}

export function analyzeSecretsText(text: string, existingNames: readonly string[], translator: Translator = defaultTranslator): SecretsTextAnalysis {
	const parsed = parseEnvPaste(text);
	const entries = parsed.entries.map(({ name, value }) => ({ name, value }));
	return { entries, errors: parsed.errors.map((error) => translateSecretError(error.message, translator)), overwrites: entries.map((entry) => entry.name).filter((name) => existingNames.includes(name)) };
}

/** Erro de limite: segredos novos + já salvos (sem contar os que serão sobrescritos). */
export function secretLimitError(entryNames: readonly string[], existingNames: readonly string[], { t }: Translator = defaultTranslator): string | null {
	const total = new Set([...existingNames, ...entryNames]).size;
	return total > DEV_ENV_MAX_SECRETS ? t("settings.dev.err.secretLimit", { max: DEV_ENV_MAX_SECRETS }) : null;
}

export function savedSecretsLabel(count: number, { tn }: Translator = defaultTranslator): string {
	return tn("settings.dev.secretsSaved", count);
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
export function envSummary(env: Pick<DevEnvironmentView, "tier" | "network" | "secrets"> & { approvalMode?: DevApprovalMode | null }, translator: Translator = defaultTranslator): string {
	const parts: string[] = [devEnvTierLabel(env.tier, translator), devEnvNetworkLabel(env.network, translator)];
	if (env.approvalMode) parts.push(translator.t("settings.dev.summaryCommands", { mode: devApprovalModeLabel(env.approvalMode, translator) }));
	if (env.secrets.length > 0) parts.push(translator.tn("settings.dev.summarySecrets", env.secrets.length));
	return parts.join(" · ");
}

export function environmentsHint(count: number | undefined, { tn }: Translator = defaultTranslator): string | null {
	if (!count) return null;
	return tn("settings.dev.hint", count);
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

export function envErrorMessage(cause: unknown, { t }: Translator = getActiveTranslator()): string {
	return cause instanceof Error && cause.message ? cause.message : t("settings.dev.err.generic");
}

