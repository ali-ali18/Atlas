import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import {
	GITHUB_APP_EVENTS,
	GITHUB_APP_PERMISSIONS,
	buildGithubAppManifest,
	convertManifestCode,
	exchangeUserOAuthCode,
	fetchAppPermissions,
	fetchInstallationInfo,
	forgetInstallationTokens,
	githubInstallationManageUrl,
	missingGithubWritePermissions,
	getInstallationToken,
	githubAppUrls,
	githubManifestTarget,
	listInstallationRepositories,
	listUserInstallationIds,
	loadGithubAppCredentials,
	renderManifestForm,
	sanitizeGithubAppName,
	saveConvertedGithubApp,
	signGithubAppState,
	verifyGithubAppState,
	invalidateGithubAppCredentials,
} from "@workspace/agent-runtime";
import {
	deleteGithubAppConfigRecord,
	deleteGithubInstallationForUser,
	getGithubAppConfigRecord,
	getGithubWriteSettings,
	saveGithubWriteSettings,
	linkGithubInstallation,
	listGithubInstallationsForUser,
	updateGithubInstallationByInstallationId,
	type GithubInstallationRecord,
} from "@workspace/db";
import { isOwnerEmail } from "../auth.js";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * GitHub App da instância: criação em um clique pelo manifest (só o dono), instalação por usuário
 * (state assinado + prova de OAuth) e leitura do estado para as Configurações. Nunca devolve
 * segredo (chave privada, client secret, webhook secret) ao client.
 */

export type GithubAppRouteDeps = {
	loadCredentials: typeof loadGithubAppCredentials;
	getConfigRecord: typeof getGithubAppConfigRecord;
	saveConverted: typeof saveConvertedGithubApp;
	deleteConfig: () => Promise<void>;
	convertCode: typeof convertManifestCode;
	fetchInstallation: typeof fetchInstallationInfo;
	installationToken: typeof getInstallationToken;
	listRepos: typeof listInstallationRepositories;
	exchangeOAuth: typeof exchangeUserOAuthCode;
	listUserInstallations: typeof listUserInstallationIds;
	link: typeof linkGithubInstallation;
	listForUser: typeof listGithubInstallationsForUser;
	deleteForUser: typeof deleteGithubInstallationForUser;
	updateInstallation: typeof updateGithubInstallationByInstallationId;
	fetchPermissions: typeof fetchAppPermissions;
	getWriteSettings: typeof getGithubWriteSettings;
	saveWriteSettings: typeof saveGithubWriteSettings;
	isOwner: (email: string) => boolean;
	now: () => number;
	env: () => NodeJS.ProcessEnv;
};

export const DEFAULT_GITHUB_APP_ROUTE_DEPS: GithubAppRouteDeps = {
	loadCredentials: loadGithubAppCredentials,
	getConfigRecord: getGithubAppConfigRecord,
	saveConverted: saveConvertedGithubApp,
	deleteConfig: async () => {
		await deleteGithubAppConfigRecord();
		invalidateGithubAppCredentials();
	},
	convertCode: convertManifestCode,
	fetchInstallation: fetchInstallationInfo,
	installationToken: getInstallationToken,
	listRepos: listInstallationRepositories,
	exchangeOAuth: exchangeUserOAuthCode,
	listUserInstallations: listUserInstallationIds,
	link: linkGithubInstallation,
	listForUser: listGithubInstallationsForUser,
	deleteForUser: deleteGithubInstallationForUser,
	updateInstallation: updateGithubInstallationByInstallationId,
	fetchPermissions: fetchAppPermissions,
	getWriteSettings: getGithubWriteSettings,
	saveWriteSettings: saveGithubWriteSettings,
	isOwner: isOwnerEmail,
	now: () => Date.now(),
	env: () => process.env,
};

const REPOS_SHOWN = 50;
const REPOS_STORED = 300;
const DIGITS = new RegExp("^[0-9]{1,20}$");
const MANIFEST_CODE = new RegExp("^[A-Za-z0-9_-]{8,128}$");

export type GithubAppInstallationView = {
	id: string;
	accountLogin: string;
	accountType: string;
	repositorySelection: "all" | "selected";
	repoCount: number | null;
	repos: Array<{ fullName: string; private: boolean }>;
	suspended: boolean;
	manageUrl: string;
	createdAt: string;
};

export function installationView(inst: GithubInstallationRecord): GithubAppInstallationView {
	const repos = inst.repositories ?? [];
	return {
		id: inst.id,
		accountLogin: inst.accountLogin,
		accountType: inst.accountType,
		repositorySelection: inst.repositorySelection === "all" ? "all" : "selected",
		repoCount: inst.repositories ? repos.length : null,
		repos: repos.slice(0, REPOS_SHOWN),
		suspended: inst.suspendedAt !== null,
		manageUrl: githubInstallationManageUrl(inst),
		createdAt: inst.createdAt.toISOString(),
	};
}

function webOrigin(env: NodeJS.ProcessEnv): string {
	return (env.ATLAS_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** Volta ao modal de Conexões com um código de resultado (`github=installed`, `github_error=…`). */
function backToSettings(env: NodeJS.ProcessEnv, result: { ok?: string; error?: string }): string {
	const q = new URLSearchParams({ settings: "conexoes" });
	if (result.ok) q.set("github", result.ok);
	if (result.error) q.set("github_error", result.error);
	return `${webOrigin(env)}/?${q.toString()}`;
}

function defaultAppName(userId: string): string {
	return `Agente de Código ${createHash("sha1").update(userId).digest("hex").slice(0, 4)}`;
}

export function createGithubAppRoutes(deps: GithubAppRouteDeps = DEFAULT_GITHUB_APP_ROUTE_DEPS) {
	const app = new Hono<AuthEnv>();

	const requireOwner = (c: Context<AuthEnv>): boolean => deps.isOwner(c.get("session").user.email);

	/** Estado para as Configurações (sem segredos). */
	app.get("/v1/github-app/status", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const env = deps.env();
		const creds = await deps.loadCredentials({ cacheMs: 0 });
		const urls = githubAppUrls({ webUrl: webOrigin(env), publicUrl: env.ATLAS_PUBLIC_URL?.trim() || undefined });
		const records = await deps.listForUser(userId);
		const installations = records.map(installationView);
		const writeSettings = await deps.getWriteSettings(userId).catch(() => ({ signature: false, signatureText: null }));
		// Permissões que o app tem hoje no GitHub (mudar o manifest não atualiza apps já criados).
		const granted = creds ? await deps.fetchPermissions(creds).catch(() => null) : null;
		const missingWritePermissions = granted && !granted.error ? missingGithubWritePermissions(granted.data) : [];
		return c.json({
			signature: writeSettings.signature,
			signatureText: writeSettings.signatureText,
			missingWritePermissions,
			permissionsUrl: creds ? `https://github.com/apps/${creds.slug}` : null,
			configured: creds !== null,
			isOwner: requireOwner(c),
			source: creds?.source ?? null,
			slug: creds?.slug ?? null,
			name: creds?.name ?? null,
			appUrl: creds ? `https://github.com/apps/${creds.slug}` : null,
			canVerifyInstall: Boolean(creds?.clientId && creds?.clientSecret),
			webhookUrl: urls.webhook,
			defaultName: defaultAppName(userId),
			permissions: GITHUB_APP_PERMISSIONS,
			events: GITHUB_APP_EVENTS,
			installations,
		});
	});

	/** Assinatura opcional no rodapé das escritas do bot (as escritas sempre usam o app). */
	app.put("/v1/github-app/write-settings", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== "object") return c.json({ error: "Corpo inválido" }, 400);
		const patch: { signature?: boolean; signatureText?: string | null } = {};
		if (body.signature !== undefined) {
			if (typeof body.signature !== "boolean") return c.json({ error: "signature inválido" }, 400);
			patch.signature = body.signature;
		}
		if (body.signatureText !== undefined) {
			if (body.signatureText !== null && typeof body.signatureText !== "string") return c.json({ error: "signatureText inválido" }, 400);
			patch.signatureText = body.signatureText;
		}
		return c.json(await deps.saveWriteSettings(userId, patch));
	});

	/** Dono: página intermediária que envia o manifest ao GitHub (um clique). */
	app.get("/v1/github-app/manifest/start", async (c) => {
		if (!requireOwner(c)) return c.json({ error: "Not found" }, 404);
		const env = deps.env();
		if (await deps.loadCredentials({ cacheMs: 0 })) return c.redirect(backToSettings(env, { error: "already_configured" }));
		const { userId } = scopeFor(c.get("session"));
		const target = githubManifestTarget(c.req.query("org") ?? undefined, signGithubAppState({ userId, purpose: "manifest", now: deps.now }));
		if (!target) return c.redirect(backToSettings(env, { error: "invalid_org" }));
		const name = sanitizeGithubAppName(c.req.query("name"), defaultAppName(userId));
		const manifest = buildGithubAppManifest({
			name,
			webUrl: webOrigin(env),
			publicUrl: env.ATLAS_PUBLIC_URL?.trim() || undefined,
		});
		c.header("Cache-Control", "no-store");
		return c.html(renderManifestForm({ action: target, manifest }));
	});

	/** Volta do GitHub com o `code` do manifest: troca pelas credenciais e guarda cifradas. */
	app.get("/v1/github-app/manifest/callback", async (c) => {
		const env = deps.env();
		if (!requireOwner(c)) return c.json({ error: "Not found" }, 404);
		const { userId } = scopeFor(c.get("session"));
		const state = verifyGithubAppState(c.req.query("state"), { purpose: "manifest", now: deps.now });
		if (!state || state.userId !== userId) return c.redirect(backToSettings(env, { error: "state_invalid" }));
		const code = c.req.query("code") ?? "";
		if (!MANIFEST_CODE.test(code)) return c.redirect(backToSettings(env, { error: "code_invalid" }));
		if (await deps.getConfigRecord()) return c.redirect(backToSettings(env, { error: "already_configured" }));
		const converted = await deps.convertCode(code);
		if (converted.error) {
			console.error(`[github-app] conversão do manifest falhou status=${converted.error.status}`);
			return c.redirect(backToSettings(env, { error: "conversion_failed" }));
		}
		try {
			await deps.saveConverted(converted.data);
		} catch (error) {
			console.error("[github-app] não foi possível guardar o app", error instanceof Error ? error.message : "erro");
			return c.redirect(backToSettings(env, { error: "save_failed" }));
		}
		return c.redirect(backToSettings(env, { ok: "created" }));
	});

	/** Remove o app guardado (dono). As instalações dos usuários deixam de funcionar até criar de novo. */
	app.delete("/v1/github-app", async (c) => {
		if (!requireOwner(c)) return c.json({ error: "Not found" }, 404);
		const creds = await deps.loadCredentials({ cacheMs: 0 });
		if (creds?.source === "env") return c.json({ error: "Configurado por variáveis de ambiente" }, 409);
		await deps.deleteConfig();
		return c.json({ ok: true });
	});

	/** "Instalar no GitHub": redireciona com o `state` assinado do usuário. */
	app.get("/v1/github-app/install", async (c) => {
		const env = deps.env();
		const creds = await deps.loadCredentials({ cacheMs: 0 });
		if (!creds) return c.redirect(backToSettings(env, { error: "app_missing" }));
		const { userId } = scopeFor(c.get("session"));
		const state = signGithubAppState({ userId, purpose: "install", now: deps.now });
		return c.redirect(`https://github.com/apps/${encodeURIComponent(creds.slug)}/installations/new?state=${encodeURIComponent(state)}`);
	});

	/**
	 * Volta do GitHub após instalar/atualizar. Segurança: `state` assinado e com validade curta
	 * ligado à sessão; o `installation_id` da query só vale se o `code` OAuth provar que o usuário
	 * do GitHub enxerga essa instalação.
	 */
	app.get("/v1/github-app/setup", async (c) => {
		const env = deps.env();
		const { userId } = scopeFor(c.get("session"));
		const state = verifyGithubAppState(c.req.query("state"), { purpose: "install", now: deps.now });
		if (!state || state.userId !== userId) return c.redirect(backToSettings(env, { error: "state_invalid" }));
		if (c.req.query("setup_action") === "request") return c.redirect(backToSettings(env, { ok: "pending" }));
		const installationId = c.req.query("installation_id") ?? "";
		if (!DIGITS.test(installationId)) return c.redirect(backToSettings(env, { error: "installation_invalid" }));
		const creds = await deps.loadCredentials({ cacheMs: 0 });
		if (!creds) return c.redirect(backToSettings(env, { error: "app_missing" }));
		const code = c.req.query("code") ?? "";
		if (!code || !creds.clientId || !creds.clientSecret) return c.redirect(backToSettings(env, { error: "authorization_missing" }));

		const oauth = await deps.exchangeOAuth({ clientId: creds.clientId, clientSecret: creds.clientSecret, code });
		if (oauth.error) return c.redirect(backToSettings(env, { error: "oauth_failed" }));
		const mine = await deps.listUserInstallations(oauth.data.accessToken);
		if (mine.error || !mine.data.includes(installationId)) {
			return c.redirect(backToSettings(env, { error: "installation_not_yours" }));
		}
		const info = await deps.fetchInstallation(creds, installationId);
		if (info.error) return c.redirect(backToSettings(env, { error: "installation_unavailable" }));
		const repos = await readRepos(deps, installationId);
		const linked = await deps.link({
			userId,
			installationId,
			accountLogin: info.data.accountLogin,
			accountType: info.data.accountType,
			repositorySelection: info.data.repositorySelection,
			repositories: repos,
			suspendedAt: info.data.suspendedAt ? new Date(info.data.suspendedAt) : null,
		});
		if (!linked) return c.redirect(backToSettings(env, { error: "already_linked" }));
		return c.redirect(backToSettings(env, { ok: "installed" }));
	});

	/** Relê status e repositórios no GitHub (instalação do próprio usuário). */
	app.post("/v1/github-app/installations/:id/refresh", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const inst = (await deps.listForUser(userId)).find((i) => i.id === c.req.param("id"));
		if (!inst) return c.json({ error: "Not found" }, 404);
		const creds = await deps.loadCredentials({ cacheMs: 0 });
		if (!creds) return c.json({ error: "GitHub App não configurado" }, 409);
		const info = await deps.fetchInstallation(creds, inst.installationId);
		if (info.error) {
			if (info.error.status === 404) {
				await deps.deleteForUser(userId, inst.id);
				forgetInstallationTokens(inst.installationId);
				return c.json({ removed: true });
			}
			return c.json({ error: "Não consegui falar com o GitHub" }, 502);
		}
		const repos = await readRepos(deps, inst.installationId);
		await deps.updateInstallation(inst.installationId, {
			accountLogin: info.data.accountLogin,
			repositorySelection: info.data.repositorySelection,
			repositories: repos ?? inst.repositories,
			suspendedAt: info.data.suspendedAt ? new Date(info.data.suspendedAt) : null,
		});
		const fresh = (await deps.listForUser(userId)).find((i) => i.id === inst.id);
		return c.json({ installation: fresh ? installationView(fresh) : null });
	});

	/** Desvincula (só deste lado; para desinstalar de vez, "Gerenciar no GitHub"). */
	app.delete("/v1/github-app/installations/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const removed = await deps.deleteForUser(userId, c.req.param("id"));
		if (!removed) return c.json({ error: "Not found" }, 404);
		forgetInstallationTokens(removed.installationId);
		return c.json({ ok: true });
	});

	return app;
}

async function readRepos(
	deps: Pick<GithubAppRouteDeps, "installationToken" | "listRepos">,
	installationId: string,
): Promise<Array<{ fullName: string; private: boolean }> | null> {
	const token = await deps.installationToken(installationId);
	if ("error" in token) return null;
	const res = await deps.listRepos(token.token);
	return res.error ? null : res.data.slice(0, REPOS_STORED);
}
