import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { GithubAppInstallation, GithubAppStatus } from "@/lib/atlas-api";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { githubAccountLabel, githubMissingPermissionsText, githubNoticeFromSearch, githubRepoCountLabel } from "./github-app-state";
import { GithubAppSettingsView } from "./sections/github-app";

Object.assign(globalThis, { React });

const noop = () => {};
const inst: GithubAppInstallation = {
	id: "i1", accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", repoCount: 12,
	repos: [{ fullName: "acme/site", private: true }], suspended: true, manageUrl: "https://github.com/x", createdAt: "2026-10-14T00:00:00.000Z",
};
const status: GithubAppStatus = {
	configured: true, isOwner: true, source: "db", slug: "meu-app", name: "Meu App", appUrl: "https://github.com/apps/meu-app", canVerifyInstall: true,
	webhookUrl: "https://x.test/hook", defaultName: "Agente", signature: true, signatureText: null, missingWritePermissions: ["issues"],
	permissionsUrl: "https://github.com/apps/app", installations: [inst],
} as GithubAppStatus;
const props = { busy: null, onRefresh: noop, onUnlink: noop, onRemoveApp: noop };
const tr = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale));

test("GitHub em inglês: instalação, assinatura e permissões", async () => {
	const html = await renderIn("en-US", <GithubAppSettingsView {...props} status={status} />);
	assert.match(html, /acme · Organization/);
	assert.match(html, /12 repositories · Suspended/);
	assert.match(html, /Writes on GitHub/);
	assert.match(html, /doesn&#x27;t have write permission yet for: Issues/);
	assert.match(html, /Sign in the footer/);
	assert.match(html, /aria-label="Signature text"/);
	assert.match(html, /Another account or organization/);
	assert.doesNotMatch(html, /Escritas|Suspenso|Outra conta/);
});

test("GitHub: criar app (dono) e aguardando dono, em espanhol", async () => {
	const create = await renderIn("es-ES", <GithubAppSettingsView {...props} status={{ ...status, configured: false, installations: [] } as GithubAppStatus} />);
	assert.match(create, /Crear app de GitHub/);
	assert.match(create, /aria-label="Nombre de la app en GitHub"/);
	const waiting = await renderIn("es-ES", <GithubAppSettingsView {...props} status={{ ...status, configured: false, isOwner: false, installations: [] } as GithubAppStatus} />);
	assert.match(waiting, /aún no ha creado la app de GitHub/);
});

test("estado do GitHub: avisos de retorno e rótulos por idioma", async () => {
	const en = await tr("en-US");
	assert.equal(githubNoticeFromSearch("?github=installed", en)?.text, "GitHub connected. Events from the chosen repositories now reach the agent.");
	assert.equal(githubNoticeFromSearch("?github_error=oauth_failed", en)?.tone, "error");
	assert.equal(githubNoticeFromSearch("?github_error=nada", en)?.text, "Could not finish the GitHub connection.");
	assert.equal(githubNoticeFromSearch("", en), null);
	assert.equal(githubRepoCountLabel({ repositorySelection: "selected", repoCount: 1 }, en), "1 repository");
	assert.equal(githubAccountLabel({ accountLogin: "ana", accountType: "User" }, await tr("es-ES")), "ana · Cuenta personal");
	assert.match(githubMissingPermissionsText(["contents"], en), /Contents/);
});
