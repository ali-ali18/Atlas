import { getGithubAppConfigRecord, saveGithubAppConfigRecord } from "@workspace/db";
import { openSecrets, sealSecrets } from "../../secrets/secret-box.js";

/** Credenciais do GitHub App da instância (env sobrepõe o que o dono criou pelo manifest). */
export type GithubAppCredentials = {
	appId: string;
	slug: string;
	privateKey: string;
	webhookSecret: string;
	clientId?: string;
	clientSecret?: string;
	name?: string;
	/** De onde veio: `env` (override de ops) ou `db` (manifest flow). */
	source: "env" | "db";
};

type SealedAppSecrets = {
	clientSecret?: string;
	webhookSecret: string;
	privateKey: string;
};

const BACKSLASH = String.fromCharCode(92);

/** Chave PEM de variável de ambiente: aceita `\n` literal e base64 do PEM inteiro. */
export function normalizePrivateKey(raw: string): string {
	let key = raw.trim().replace(/^["']|["']$/g, "");
	if (!key.includes("BEGIN")) {
		try {
			const decoded = Buffer.from(key, "base64").toString("utf8");
			if (decoded.includes("BEGIN")) key = decoded;
		} catch {
			// segue com o valor original
		}
	}
	return key.split(`${BACKSLASH}n`).join("\n").trim();
}

export type GithubAppConfigDeps = {
	env?: NodeJS.ProcessEnv;
	loadRecord?: typeof getGithubAppConfigRecord;
	/** Cache em memória (ms); 0 desliga (testes). */
	cacheMs?: number;
};

let cached: { at: number; value: GithubAppCredentials | null } | null = null;

export function invalidateGithubAppCredentials(): void {
	cached = null;
}

/**
 * Credenciais efetivas: cada campo vem do env (`GITHUB_APP_*`) quando definido, senão do
 * banco (segredos abertos com CONNECTOR_ENCRYPTION_KEY). `null` = GitHub App não configurado.
 */
export async function loadGithubAppCredentials(deps: GithubAppConfigDeps = {}): Promise<GithubAppCredentials | null> {
	const cacheMs = deps.cacheMs ?? 30_000;
	if (cacheMs > 0 && cached && Date.now() - cached.at < cacheMs) return cached.value;
	const env = deps.env ?? process.env;
	const envKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
	let record: Awaited<ReturnType<typeof getGithubAppConfigRecord>> = null;
	try {
		record = await (deps.loadRecord ?? getGithubAppConfigRecord)();
	} catch {
		record = null;
	}
	let sealed: Partial<SealedAppSecrets> = {};
	if (record) {
		try {
			sealed = openSecrets<SealedAppSecrets>(record.secretsEnc);
		} catch {
			sealed = {};
		}
	}
	const appId = env.GITHUB_APP_ID?.trim() || record?.appId;
	const privateKey = envKey ? normalizePrivateKey(envKey) : sealed.privateKey;
	const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim() || sealed.webhookSecret;
	const slug = env.GITHUB_APP_SLUG?.trim() || record?.slug;
	let value: GithubAppCredentials | null = null;
	if (appId && privateKey && webhookSecret && slug) {
		value = {
			appId,
			slug,
			privateKey,
			webhookSecret,
			clientId: env.GITHUB_APP_CLIENT_ID?.trim() || record?.clientId,
			clientSecret: env.GITHUB_APP_CLIENT_SECRET?.trim() || sealed.clientSecret,
			name: record?.name,
			source: env.GITHUB_APP_ID?.trim() && envKey ? "env" : "db",
		};
	}
	if (cacheMs > 0) cached = { at: Date.now(), value };
	return value;
}

export type ConvertedGithubApp = {
	id: number | string;
	slug: string;
	name: string;
	html_url?: string;
	client_id: string;
	client_secret: string;
	webhook_secret: string;
	pem: string;
	owner?: { login?: string };
};

/** Guarda o resultado da conversão do manifest (segredos cifrados). */
export async function saveConvertedGithubApp(
	app: ConvertedGithubApp,
	save: typeof saveGithubAppConfigRecord = saveGithubAppConfigRecord,
): Promise<void> {
	await save({
		appId: String(app.id),
		slug: app.slug,
		name: app.name,
		htmlUrl: app.html_url ?? null,
		clientId: app.client_id,
		ownerLogin: app.owner?.login ?? null,
		secretsEnc: sealSecrets<SealedAppSecrets>({
			clientSecret: app.client_secret,
			webhookSecret: app.webhook_secret,
			privateKey: app.pem,
		}),
	});
	invalidateGithubAppCredentials();
}
