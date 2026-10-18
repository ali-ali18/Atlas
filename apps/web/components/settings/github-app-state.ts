import type { GithubAppInstallation, GithubAppStatus } from "@/lib/atlas-api";

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

export function githubRepoCountLabel(inst: Pick<GithubAppInstallation, "repositorySelection" | "repoCount">): string {
	if (inst.repositorySelection === "all") return "Todos os repositórios";
	const n = inst.repoCount ?? 0;
	return n === 1 ? "1 repositório" : `${n} repositórios`;
}

export function githubInstallationStatus(inst: Pick<GithubAppInstallation, "suspended">): { label: string; tone: "ok" | "warn" } {
	return inst.suspended ? { label: "Suspenso", tone: "warn" } : { label: "Ativo", tone: "ok" };
}

export function githubAccountLabel(inst: Pick<GithubAppInstallation, "accountLogin" | "accountType">): string {
	return `${inst.accountLogin} · ${inst.accountType === "Organization" ? "Organização" : "Conta pessoal"}`;
}

/** Nome do bot do app como o GitHub mostra ("<app>[bot]"). */
export function githubBotLabel(status: Pick<GithubAppStatus, "slug" | "name">): string {
	return `${status.slug ?? status.name ?? "app"}[bot]`;
}

export function githubWriteAsCaption(status: Pick<GithubAppStatus, "slug" | "name">): string {
	return `Tudo que o bot escreve no GitHub (issues, comentários, PRs, reviews) aparece como ${githubBotLabel(status)}, nunca como a sua conta. Se o repositório não estiver no app, o bot pede para instalar.`;
}

const PERMISSION_LABELS: Record<string, string> = { issues: "Issues", pull_requests: "Pull requests", contents: "Contents" };

export function githubMissingPermissionsText(missing: string[]): string {
	const names = missing.map((name) => PERMISSION_LABELS[name] ?? name).join(", ");
	return `O app ainda não tem permissão de escrita em: ${names}. Abra a instalação no GitHub e aceite as novas permissões; sem isso o bot não consegue escrever como o app.`;
}

export type GithubNotice = { tone: "success" | "error" | "info"; text: string };

const OK_NOTICES: Record<string, GithubNotice> = {
	created: { tone: "success", text: "App criado no GitHub. Agora instale nos repositórios que o agente pode usar." },
	installed: { tone: "success", text: "GitHub conectado. Os eventos dos repositórios escolhidos já chegam ao agente." },
	pending: { tone: "info", text: "A instalação aguarda a aprovação de um administrador da organização no GitHub." },
};

const ERROR_NOTICES: Record<string, string> = {
	state_invalid: "O link de retorno expirou ou não é válido. Tente de novo.",
	app_missing: "O app do GitHub ainda não foi criado. Peça ao dono da instância.",
	authorization_missing: "O GitHub não confirmou a sua autorização. Instale de novo e autorize o app.",
	oauth_failed: "Não foi possível confirmar a sua conta no GitHub. Tente de novo.",
	installation_not_yours: "Essa instalação não pertence à sua conta do GitHub.",
	installation_invalid: "O GitHub devolveu uma instalação inválida.",
	installation_unavailable: "Não consegui ler a instalação no GitHub. Tente de novo.",
	already_linked: "Essa instalação já está vinculada a outro usuário.",
	already_configured: "O app do GitHub já foi criado.",
	invalid_org: "O nome da organização é inválido.",
	code_invalid: "O código devolvido pelo GitHub é inválido. Tente criar o app de novo.",
	conversion_failed: "O GitHub recusou a criação do app. Confira o nome (precisa ser único) e tente de novo.",
	save_failed: "O app foi criado, mas não foi possível guardá-lo. Confira a chave de criptografia do servidor.",
};

/** Mensagem a partir dos parâmetros de URL; `null` quando não há retorno do GitHub. */
export function githubNoticeFromSearch(search: string): GithubNotice | null {
	const params = new URLSearchParams(search);
	const error = params.get("github_error");
	if (error) {
		return { tone: "error", text: ERROR_NOTICES[error] ?? "Não foi possível concluir a conexão com o GitHub." };
	}
	const ok = params.get("github");
	return ok ? (OK_NOTICES[ok] ?? null) : null;
}

/** Remove só os parâmetros de retorno do GitHub (mantém `?settings=`). */
export function stripGithubParams(search: string): string {
	const params = new URLSearchParams(search);
	params.delete("github");
	params.delete("github_error");
	const text = params.toString();
	return text ? `?${text}` : "";
}
