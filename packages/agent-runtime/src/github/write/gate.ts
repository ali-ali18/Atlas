import {
	getGithubWriteSettings,
	listGithubInstallationsForUser,
	updateGithubInstallationByInstallationId,
	installationCoversRepo,
	type GithubInstallationRecord,
	type GithubWriteSettings,
} from "@workspace/db";
import type { McpCallResult } from "../../mcp/call.js";
import { loadGithubAppCredentials, type GithubAppCredentials } from "../app/credentials.js";
import { getInstallationToken, type InstallationTokenResult } from "../app/token.js";
import type { FetchFn } from "../app/api.js";
import { listInstallationRepositories } from "../app/api.js";
import { planGithubWrite, type GithubWritePlan } from "./ops.js";

/**
 * Identidade das escritas no GitHub: sempre o app ("<app>[bot]"). Se o repositório não está na
 * instalação (ou falta permissão), nada é enviado e o bloqueio vira um cartão para instalar/aceitar.
 */
export const GITHUB_APP_INSTALL_PATH = "/v1/github-app/install";

export type GithubIdentityBlockReason = "not_installed" | "app_missing" | "suspended" | "token_failed" | "no_permission";

export type GithubIdentityBlock = {
	reason: GithubIdentityBlockReason;
	repo: string | null;
	/** Link para instalar/ajustar o app neste repositório (relativo ao app web ou github.com). */
	installUrl: string | null;
	/** Nome do app (para o cartão). */
	appName: string | null;
	message: string;
};

export type GithubWriteGateDeps = {
	loadSettings?: (userId: string) => Promise<GithubWriteSettings>;
	listInstallations?: (userId: string) => Promise<GithubInstallationRecord[]>;
	loadCredentials?: () => Promise<GithubAppCredentials | null>;
	installationToken?: (installationId: string, options: { repo?: string }) => Promise<InstallationTokenResult>;
	/** Relê no GitHub os repositórios da instalação (o usuário pode ter acabado de adicionar o repositório). */
	refreshInstallation?: (inst: GithubInstallationRecord) => Promise<GithubInstallationRecord | null>;
	fetchFn?: FetchFn;
};

export function githubInstallationManageUrl(inst: Pick<GithubInstallationRecord, "accountType" | "accountLogin" | "installationId">): string {
	return inst.accountType === "Organization"
		? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
		: `https://github.com/settings/installations/${inst.installationId}`;
}

/** A tool é uma escrita no GitHub (conector nativo ou toolkit do Composio)? */
export function isGithubWriteConnector(catalogId: string | null | undefined, toolName: string): boolean {
	if (catalogId === "github") return true;
	return catalogId === "composio" && /^github_/i.test(toolName);
}

export function githubSignatureFor(settings: GithubWriteSettings, botName?: string): string | null {
	if (!settings.signature) return null;
	return settings.signatureText ?? (botName?.trim() ? `enviado pelo bot ${botName.trim()}` : "enviado pelo bot");
}

function block(input: GithubIdentityBlock): McpCallResult {
	return { ok: false, text: input.message, truncated: false, githubIdentity: input };
}

function blockText(reason: GithubIdentityBlockReason, repo: string | null, appName: string | null, detail?: string): string {
	const as = appName ? `"${appName}[bot]"` : "o app do GitHub";
	const target = repo ?? "este repositório";
	const tail = "Nada foi enviado. Um cartão pede ao usuário para instalar/ajustar o app; quando ele tocar em Pronto a ação é refeita sozinha. Não tente de outra forma e nunca peça token ou use a conta pessoal dele.";
	switch (reason) {
		case "not_installed":
			return `Para escrever como ${as}, o app precisa estar instalado em ${target}, e não está. ${tail}`;
		case "suspended":
			return `A instalação do app que cobre ${target} está suspensa no GitHub. ${tail}`;
		case "app_missing":
			return `O app do GitHub ainda não foi criado nesta instância. ${tail}`;
		case "token_failed":
			return `Não consegui o acesso do app a ${target}${detail ? ` (${detail})` : ""}. ${tail}`;
		default:
			return `O app não tem permissão de escrita para esta ação em ${target}${detail ? ` (${detail})` : ""}. O usuário precisa aceitar as novas permissões do app no GitHub. ${tail}`;
	}
}

async function defaultRefresh(inst: GithubInstallationRecord): Promise<GithubInstallationRecord | null> {
	const token = await getInstallationToken(inst.installationId);
	if ("error" in token) return null;
	const repos = await listInstallationRepositories(token.token);
	if (repos.error) return null;
	await updateGithubInstallationByInstallationId(inst.installationId, { repositories: repos.data.slice(0, 300) }).catch(() => undefined);
	return { ...inst, repositories: repos.data.slice(0, 300) };
}

/**
 * Toda escrita no GitHub é feita pelo app (token de instalação). A conta pessoal do usuário (OAuth,
 * PAT, Composio) nunca escreve. Devolve sempre o resultado: feito pelo app, bloqueio com cartão
 * (instalar/aceitar permissões) ou erro claro quando a ação não existe no app.
 */
export async function gateGithubWrite(
	input: { userId: string; toolName: string; args: Record<string, unknown>; botName?: string },
	deps: GithubWriteGateDeps = {},
): Promise<McpCallResult> {
	const settings = await (deps.loadSettings ?? getGithubWriteSettings)(input.userId).catch(
		(): GithubWriteSettings => ({ signature: false, signatureText: null }),
	);
	const signature = githubSignatureFor(settings, input.botName);
	const [installs, creds] = await Promise.all([
		(deps.listInstallations ?? listGithubInstallationsForUser)(input.userId).catch(() => [] as GithubInstallationRecord[]),
		(deps.loadCredentials ?? (() => loadGithubAppCredentials()))().catch(() => null),
	]);
	const appName = creds?.name ?? creds?.slug ?? null;
	const lookup = planGithubWrite(input.toolName, input.args);
	const repo = lookup.plan ? lookup.plan.repo : lookup.repo;
	if (!creds) return block({ reason: "app_missing", repo, installUrl: null, appName, message: blockText("app_missing", repo, appName) });
	if (!lookup.plan) {
		return {
			ok: false,
			truncated: false,
			text: `Esta ação no GitHub ("${input.toolName}") não pode ser feita pelo app ${appName ? `"${appName}[bot]"` : ""} com os dados informados, e a conta pessoal do usuário nunca é usada para escrever. Explique ao usuário o que não foi possível e proponha uma alternativa (por exemplo, uma sessão de código ou fazer isso manualmente no GitHub).`,
		};
	}
	const plan: GithubWritePlan = lookup.plan;
	let inst = installs.find((i) => installationCoversRepo(i, plan.repo));
	if (!inst) {
		// O usuário pode ter acabado de adicionar o repositório à instalação: relê antes de pedir de novo.
		const owner = plan.repo.split("/")[0]!.toLowerCase();
		for (const candidate of installs.filter((i) => !i.suspendedAt && i.accountLogin.toLowerCase() === owner)) {
			const fresh = await (deps.refreshInstallation ?? defaultRefresh)(candidate).catch(() => null);
			if (fresh && installationCoversRepo(fresh, plan.repo)) {
				inst = fresh;
				break;
			}
		}
	}
	if (!inst) {
		const owner = plan.repo.split("/")[0]!.toLowerCase();
		const sameOwner = installs.find((i) => i.accountLogin.toLowerCase() === owner);
		const suspended = installs.some(
			(i) => i.suspendedAt && (i.repositorySelection === "all" ? i.accountLogin.toLowerCase() === owner : (i.repositories ?? []).some((r) => r.fullName.toLowerCase() === plan.repo.toLowerCase())),
		);
		const reason: GithubIdentityBlockReason = suspended ? "suspended" : "not_installed";
		const installUrl = sameOwner ? githubInstallationManageUrl(sameOwner) : GITHUB_APP_INSTALL_PATH;
		return block({ reason, repo: plan.repo, installUrl, appName, message: blockText(reason, plan.repo, appName) });
	}
	const tokenFor = deps.installationToken ?? ((id, o) => getInstallationToken(id, { repo: o.repo }));
	const token = await tokenFor(inst.installationId, { repo: plan.repo });
	if ("error" in token) {
		return block({ reason: "token_failed", repo: plan.repo, installUrl: githubInstallationManageUrl(inst), appName, message: blockText("token_failed", plan.repo, appName, token.error) });
	}
	const outcome = await plan.run(token.token, { fetchFn: deps.fetchFn, signature });
	if (outcome.ok) return { ok: true, text: `${outcome.text}
[Feito como ${creds.slug}[bot], identidade do app]`, truncated: false };
	if (outcome.status === 403 && /not accessible by integration/i.test(outcome.text)) {
		return block({ reason: "no_permission", repo: plan.repo, installUrl: githubInstallationManageUrl(inst), appName, message: blockText("no_permission", plan.repo, appName) });
	}
	return { ok: false, text: outcome.text, truncated: false };
}
