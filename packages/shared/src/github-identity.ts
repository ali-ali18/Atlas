/**
 * Cartão "Escrever no GitHub": o repositório não está no app (ou a ação ainda não é do app).
 * Nada foi enviado; o usuário instala o app no repositório ou usa a própria conta desta vez.
 */
export type GithubIdentityReason = "not_installed" | "app_missing" | "suspended" | "token_failed" | "no_permission";

export type GithubIdentityCardInfo = {
	reason: GithubIdentityReason;
	repo: string | null;
	/** Instalar/ajustar o app: caminho do app web (`/v1/github-app/install`) ou https://github.com/... */
	installUrl: string | null;
	appName: string | null;
};

const REASONS: readonly string[] = ["not_installed", "app_missing", "suspended", "token_failed", "no_permission"];

export function isSafeGithubInstallUrl(url: unknown): url is string {
	if (typeof url !== "string") return false;
	return url === "/v1/github-app/install" || /^https:\/\/github\.com\/[A-Za-z0-9._~\-/]+$/.test(url);
}

export function parseGithubIdentityInfo(raw: unknown): GithubIdentityCardInfo | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const row = raw as Record<string, unknown>;
	if (typeof row.reason !== "string" || !REASONS.includes(row.reason)) return undefined;
	return {
		reason: row.reason as GithubIdentityReason,
		repo: typeof row.repo === "string" && row.repo.length <= 140 ? row.repo : null,
		installUrl: isSafeGithubInstallUrl(row.installUrl) ? row.installUrl : null,
		appName: typeof row.appName === "string" ? row.appName.slice(0, 80) : null,
	};
}

/** Título, texto e rótulos do cartão (pt-BR). Só instalar o app ou aceitar permissões; nunca a conta do usuário. */
export function githubIdentityCardText(info: GithubIdentityCardInfo): { title: string; description: string; installLabel: string | null; confirmLabel: string } {
	const as = info.appName ? `${info.appName}[bot]` : "o app do GitHub";
	const repo = info.repo ?? "este repositório";
	const base: Record<GithubIdentityReason, string> = {
		not_installed: `O app não está instalado em ${repo}, então não consigo escrever como ${as}. Instale o app neste repositório e toque em Pronto: eu continuo sozinho.`,
		suspended: `A instalação do app em ${repo} está suspensa no GitHub. Reative-a e toque em Pronto: eu continuo sozinho.`,
		app_missing: "O app do GitHub ainda não foi criado nesta instância. Crie em Configurações, Conexões, GitHub, e toque em Pronto.",
		token_failed: `Não consegui o acesso do app a ${repo}. Reinstale ou ajuste o app e toque em Pronto: eu continuo sozinho.`,
		no_permission: `O app não tem permissão de escrita em ${repo}. Aceite as novas permissões do app no GitHub e toque em Pronto: eu continuo sozinho.`,
	};
	const accept = info.reason === "no_permission";
	return {
		title: accept ? "O app precisa de novas permissões" : "O app não está neste repositório",
		description: base[info.reason],
		installLabel: info.installUrl ? (info.reason === "not_installed" ? "Instalar o app neste repositório" : accept ? "Aceitar permissões no GitHub" : "Abrir o app no GitHub") : null,
		confirmLabel: accept ? "Pronto, já aceitei" : "Pronto, já instalei",
	};
}
