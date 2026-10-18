import assert from "node:assert/strict";
import test from "node:test";
import type { GithubAppInstallation, GithubAppStatus } from "@/lib/atlas-api";
import {
	githubAccountLabel,
	githubAppViewState,
	githubInstallationStatus,
	githubNoticeFromSearch,
	githubRepoCountLabel,
	stripGithubParams,
} from "./github-app-state";

const inst: GithubAppInstallation = {
	id: "i1",
	accountLogin: "acme",
	accountType: "Organization",
	repositorySelection: "selected",
	repoCount: 3,
	repos: [],
	suspended: false,
	manageUrl: "https://github.com/organizations/acme/settings/installations/1",
	createdAt: "2026-10-14T00:00:00.000Z",
};
const base: GithubAppStatus = {
	configured: true,
	isOwner: false,
	source: "db",
	slug: "app",
	name: "App",
	appUrl: "https://github.com/apps/app",
	canVerifyInstall: true,
	webhookUrl: "https://x/v1/github-app/webhook",
	defaultName: "Agente",
	signature: false,
	signatureText: null,
	missingWritePermissions: [],
	permissionsUrl: "https://github.com/apps/app",
	installations: [],
};

test("estado da tela: carregando, dono cria, usuário espera, instalar e instalado", () => {
	assert.equal(githubAppViewState(null), "loading");
	assert.equal(githubAppViewState({ ...base, configured: false, isOwner: true }), "owner-create");
	assert.equal(githubAppViewState({ ...base, configured: false, isOwner: false }), "waiting-owner");
	assert.equal(githubAppViewState(base), "install");
	assert.equal(githubAppViewState({ ...base, installations: [inst] }), "installed");
});

test("rótulos de repositórios, conta e status", () => {
	assert.equal(githubRepoCountLabel({ repositorySelection: "all", repoCount: null }), "Todos os repositórios");
	assert.equal(githubRepoCountLabel({ repositorySelection: "selected", repoCount: 1 }), "1 repositório");
	assert.equal(githubRepoCountLabel({ repositorySelection: "selected", repoCount: 3 }), "3 repositórios");
	assert.equal(githubAccountLabel(inst), "acme · Organização");
	assert.equal(githubAccountLabel({ accountLogin: "ali", accountType: "User" }), "ali · Conta pessoal");
	assert.deepEqual(githubInstallationStatus({ suspended: true }), { label: "Suspenso", tone: "warn" });
	assert.deepEqual(githubInstallationStatus({ suspended: false }), { label: "Ativo", tone: "ok" });
});

test("retorno do GitHub vira aviso e os parâmetros são removidos mantendo ?settings=", () => {
	assert.equal(githubNoticeFromSearch("?settings=conexoes&github=installed")?.tone, "success");
	assert.equal(githubNoticeFromSearch("?github=pending")?.tone, "info");
	assert.equal(githubNoticeFromSearch("?github_error=installation_not_yours")?.tone, "error");
	assert.match(githubNoticeFromSearch("?github_error=algo_novo")?.text ?? "", /Não foi possível/);
	assert.equal(githubNoticeFromSearch("?settings=conexoes"), null);
	assert.equal(stripGithubParams("?settings=conexoes&github=installed&github_error=x"), "?settings=conexoes");
	assert.equal(stripGithubParams("?github=installed"), "");
});
