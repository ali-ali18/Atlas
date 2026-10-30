import type { GithubAppInstallation, GithubAppStatus } from "@/lib/atlas-api";
import { getActiveTranslator } from "@/lib/i18n/active";
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator";

/**
 * Estado puro da seção "GitHub" de Conexões: qual tela mostrar, rótulos das instalações e as
 * mensagens de retorno do GitHub (`?github=` / `?github_error=`). Sem React.
 */
export type GithubAppViewState = "loading" | "owner-create" | "waiting-owner" | "install" | "installed";

export function githubAppViewState(status: GithubAppStatus | null): GithubAppViewState {
	if (!status) return "loading";
	if (!status.configured) return status.isOwner ? "owner-create" : "waiting-owner";
	return status.installations.length > 0 ? "installed" : "install";
}

export function githubRepoCountLabel(inst: Pick<GithubAppInstallation, "repositorySelection" | "repoCount">, { t, tn }: Translator = defaultTranslator): string {
	if (inst.repositorySelection === "all") return t("settings.github.allRepos");
	return tn("settings.github.repoCount", inst.repoCount ?? 0);
}

export function githubInstallationStatus(inst: Pick<GithubAppInstallation, "suspended">, { t }: Translator = defaultTranslator): { label: string; tone: "ok" | "warn" } {
	return inst.suspended ? { label: t("settings.github.suspended"), tone: "warn" } : { label: t("settings.github.active"), tone: "ok" };
}

export function githubAccountLabel(inst: Pick<GithubAppInstallation, "accountLogin" | "accountType">, { t }: Translator = defaultTranslator): string {
	return t(inst.accountType === "Organization" ? "settings.github.accountOrg" : "settings.github.accountPersonal", { login: inst.accountLogin });
}

/** Nome do bot do app como o GitHub mostra ("<app>[bot]"). */
export function githubBotLabel(status: Pick<GithubAppStatus, "slug" | "name">): string {
	return `${status.slug ?? status.name ?? "app"}[bot]`;
}

export function githubWriteAsCaption(status: Pick<GithubAppStatus, "slug" | "name">, { t }: Translator = defaultTranslator): string {
	return t("settings.github.writeAs", { bot: githubBotLabel(status) });
}

const PERMISSION_LABELS: Record<string, string> = { issues: "Issues", pull_requests: "Pull requests", contents: "Contents" };

export function githubMissingPermissionsText(missing: string[], { t }: Translator = defaultTranslator): string {
	const names = missing.map((name) => PERMISSION_LABELS[name] ?? name).join(", ");
	return t("settings.github.missingPermissions", { names });
}

export type GithubNotice = { tone: "success" | "error" | "info"; text: string };

const OK_NOTICES: Record<string, { tone: GithubNotice["tone"]; key: MessageKey }> = {
	created: { tone: "success", key: "settings.github.ok.created" },
	installed: { tone: "success", key: "settings.github.ok.installed" },
	pending: { tone: "info", key: "settings.github.ok.pending" },
};

const ERROR_KEYS = [
	"state_invalid",
	"app_missing",
	"authorization_missing",
	"oauth_failed",
	"installation_not_yours",
	"installation_invalid",
	"installation_unavailable",
	"already_linked",
	"already_configured",
	"invalid_org",
	"code_invalid",
	"conversion_failed",
	"save_failed",
] as const;

/** Mensagem a partir dos parâmetros de URL (no idioma da tela por padrão); `null` quando não há retorno do GitHub. */
export function githubNoticeFromSearch(search: string, translator: Translator = getActiveTranslator()): GithubNotice | null {
	const { t } = translator;
	const params = new URLSearchParams(search);
	const error = params.get("github_error");
	if (error) {
		const known = (ERROR_KEYS as readonly string[]).includes(error) ? (error as (typeof ERROR_KEYS)[number]) : null;
		return { tone: "error", text: known ? t(`settings.github.err.${known}`) : t("settings.github.err.generic") };
	}
	const ok = params.get("github");
	const notice = ok ? OK_NOTICES[ok] : undefined;
	return notice ? { tone: notice.tone, text: t(notice.key as "settings.github.ok.created") } : null;
}

/** Remove só os parâmetros de retorno do GitHub (mantém `?settings=`). */
export function stripGithubParams(search: string): string {
	const params = new URLSearchParams(search);
	params.delete("github");
	params.delete("github_error");
	const text = params.toString();
	return text ? `?${text}` : "";
}
