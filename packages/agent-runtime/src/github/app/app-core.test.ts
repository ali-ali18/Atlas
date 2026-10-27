import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
	findCoveringGithubInstallation: vi.fn(),
	getGithubAppConfigRecord: vi.fn(),
	saveGithubAppConfigRecord: vi.fn(),
	listGithubInstallationsForUser: vi.fn(async () => []),
}));

import { convertManifestCode } from "./api.js";
import { loadGithubAppCredentials, normalizePrivateKey, saveConvertedGithubApp } from "./credentials.js";
import { createGithubAppJwt } from "./jwt.js";
import {
	buildGithubAppManifest,
	githubManifestTarget,
	renderManifestForm,
	sanitizeGithubAppName,
	GITHUB_APP_EVENTS,
} from "./manifest.js";
import { signGithubAppState, verifyGithubAppState } from "./state.js";
import {
	INSTALLATION_TOKEN_REFRESH_MARGIN_MS,
	clearInstallationTokenCache,
	getGithubToken,
	getInstallationToken,
} from "./token.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const CREDS = { appId: "12345", slug: "meu-app", privateKey, webhookSecret: "whs", source: "db" as const };
const KEY = Buffer.alloc(32, 7);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("JWT do app", () => {
	it("assina RS256 com iss/iat/exp corretos e a assinatura confere com a chave pública", () => {
		const now = Date.UTC(2026, 9, 14, 12, 0, 0);
		const jwt = createGithubAppJwt({ appId: "12345", privateKey, now: () => now });
		const [h, p, sig] = jwt.split(".");
		expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
		const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
		expect(payload.iss).toBe("12345");
		expect(payload.iat).toBe(now / 1000 - 60);
		expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
		const verify = createVerify("RSA-SHA256");
		verify.update(`${h}.${p}`);
		expect(verify.verify(createPublicKey(publicKey), Buffer.from(sig!, "base64url"))).toBe(true);
	});
});

describe("estado assinado", () => {
	const now = () => 1_000_000;
	it("ida e volta, com usuário e propósito", () => {
		const s = signGithubAppState({ userId: "u1", purpose: "install", now, key: KEY });
		expect(verifyGithubAppState(s, { purpose: "install", now, key: KEY })).toEqual({ userId: "u1", purpose: "install" });
	});
	it("expira após o TTL", () => {
		const s = signGithubAppState({ userId: "u1", purpose: "install", now, key: KEY, ttlMs: 1000 });
		expect(verifyGithubAppState(s, { purpose: "install", now: () => 1_000_000 + 1001, key: KEY })).toBeNull();
	});
	it("rejeita adulteração do corpo e da assinatura, propósito errado e chave diferente", () => {
		const s = signGithubAppState({ userId: "u1", purpose: "install", now, key: KEY });
		const [body, sig] = s.split(".");
		const forged = Buffer.from(JSON.stringify({ u: "u2", p: "install", n: "x", e: 9e12 })).toString("base64url");
		expect(verifyGithubAppState(`${forged}.${sig}`, { purpose: "install", now, key: KEY })).toBeNull();
		// Troca o 1º caractere (os bits finais do base64url podem ser ignorados na decodificação).
		const tampered = `${sig![0] === "A" ? "B" : "A"}${sig!.slice(1)}`;
		expect(verifyGithubAppState(`${body}.${tampered}`, { purpose: "install", now, key: KEY })).toBeNull();
		expect(verifyGithubAppState(s, { purpose: "manifest", now, key: KEY })).toBeNull();
		expect(verifyGithubAppState(s, { purpose: "install", now, key: Buffer.alloc(32, 9) })).toBeNull();
		expect(verifyGithubAppState("lixo", { purpose: "install", now, key: KEY })).toBeNull();
		expect(verifyGithubAppState(undefined, { purpose: "install", now, key: KEY })).toBeNull();
	});
});

describe("manifest", () => {
	it("monta URLs, permissões e eventos pedidos", () => {
		const m = buildGithubAppManifest({ name: "Agente x", webUrl: "https://app.exemplo.com/", publicUrl: "https://api.exemplo.com/" });
		expect(m.hook_attributes.url).toBe("https://api.exemplo.com/v1/github-app/webhook");
		expect(m.redirect_url).toBe("https://app.exemplo.com/v1/github-app/manifest/callback");
		expect(m.callback_urls).toEqual(["https://app.exemplo.com/v1/github-app/setup"]);
		expect(m.setup_url).toBe("https://app.exemplo.com/v1/github-app/setup");
		expect(m.default_permissions).toMatchObject({ contents: "write", pull_requests: "write", checks: "read", actions: "read", statuses: "read", metadata: "read", issues: "write" });
		expect(m.default_permissions).not.toHaveProperty("members");
		expect(m.default_events).toEqual([...GITHUB_APP_EVENTS]);
		expect(m.default_events).toContain("workflow_run");
	});
	it("valida organização, limita o nome e escapa o HTML do formulário", () => {
		expect(githubManifestTarget(undefined, "s")).toBe("https://github.com/settings/apps/new?state=s");
		expect(githubManifestTarget("minha-org", "s")).toBe("https://github.com/organizations/minha-org/settings/apps/new?state=s");
		expect(githubManifestTarget("../x", "s")).toBeNull();
		expect(sanitizeGithubAppName("  ".concat("a".repeat(60)), "fb")).toHaveLength(34);
		expect(sanitizeGithubAppName("", "fb")).toBe("fb");
		const html = renderManifestForm({
			action: "https://github.com/settings/apps/new?state=a",
			manifest: buildGithubAppManifest({ name: 'x"><script>', webUrl: "https://a.com" }),
		});
		expect(html).not.toContain('x"><script>');
		expect(html).toContain("&quot;");
	});
});

describe("conversão do manifest (fetch mockado)", () => {
	it("troca o code pelas credenciais e guarda os segredos cifrados", async () => {
		process.env.CONNECTOR_ENCRYPTION_KEY = KEY.toString("base64");
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				id: 99,
				slug: "meu-app",
				name: "Meu App",
				html_url: "https://github.com/apps/meu-app",
				client_id: "Iv1.abc",
				client_secret: "csecret",
				webhook_secret: "whsecret",
				pem: privateKey,
				owner: { login: "dono" },
			}),
		) as unknown as typeof fetch;
		const res = await convertManifestCode("code1234abcd", fetchFn);
		expect(fetchFn).toHaveBeenCalledWith("https://api.github.com/app-manifests/code1234abcd/conversions", expect.objectContaining({ method: "POST" }));
		if (res.error) throw new Error("falhou");
		const save = vi.fn(async () => undefined);
		await saveConvertedGithubApp(res.data, save);
		const saved = (save.mock.calls[0] as unknown as [Record<string, unknown>])[0];
		expect(saved).toMatchObject({ appId: "99", slug: "meu-app", clientId: "Iv1.abc", ownerLogin: "dono" });
		expect(String(saved.secretsEnc)).toMatch(/^v1:/);
		expect(String(saved.secretsEnc)).not.toContain("whsecret");
	});
	it("erro do GitHub vira erro sem lançar", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch;
		const res = await convertManifestCode("code1234abcd", fetchFn);
		expect(res.error?.status).toBe(404);
	});
});

describe("credenciais: env sobrepõe o banco", () => {
	it("normaliza \\n literal e base64 do PEM", () => {
		const bs = String.fromCharCode(92);
		expect(normalizePrivateKey(`-----BEGIN KEY-----${bs}nAAA${bs}n-----END KEY-----`)).toContain("\n");
		expect(normalizePrivateKey(Buffer.from("-----BEGIN KEY-----\nAAA\n-----END KEY-----").toString("base64"))).toContain("BEGIN KEY");
	});
	it("usa só o env quando completo, ou mistura com o banco", async () => {
		const env = { GITHUB_APP_ID: "7", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_WEBHOOK_SECRET: "w", GITHUB_APP_SLUG: "s" } as NodeJS.ProcessEnv;
		const c = await loadGithubAppCredentials({ env, cacheMs: 0, loadRecord: async () => null });
		expect(c).toMatchObject({ appId: "7", slug: "s", webhookSecret: "w", source: "env" });
		expect(await loadGithubAppCredentials({ env: {} as NodeJS.ProcessEnv, cacheMs: 0, loadRecord: async () => null })).toBeNull();
	});
});

describe("token de instalação: cache e escopo", () => {
	beforeEach(() => clearInstallationTokenCache());

	function tokenFetch(expiresInMs: number, now: number) {
		let n = 0;
		return vi.fn(async (_url: unknown, _init?: unknown) => {
			n += 1;
			return jsonResponse({ token: `ghs_${n}`, expires_at: new Date(now + expiresInMs).toISOString() }, 201);
		}) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
	}

	it("reaproveita o token em cache e renova 5 min antes de expirar", async () => {
		let now = Date.UTC(2026, 9, 14, 12, 0, 0);
		const fetchFn = tokenFetch(60 * 60_000, now);
		const deps = { loadCredentials: async () => CREDS, fetchFn, now: () => now };
		const a = await getInstallationToken("11", deps);
		const b = await getInstallationToken("11", deps);
		expect(a).toEqual(b);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		now += 60 * 60_000 - INSTALLATION_TOKEN_REFRESH_MARGIN_MS + 1000;
		const c = await getInstallationToken("11", deps);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect("token" in c && c.token).toBe("ghs_2");
	});

	it("escopa o token ao repositório e cacheia por escopo", async () => {
		const now = Date.UTC(2026, 9, 14, 12, 0, 0);
		const fetchFn = tokenFetch(60 * 60_000, now);
		const deps = { loadCredentials: async () => CREDS, fetchFn, now: () => now };
		await getInstallationToken("11", { ...deps, repo: "acme/site" });
		await getInstallationToken("11", { ...deps, repo: "acme/outro" });
		await getInstallationToken("11", { ...deps, repo: "acme/site" });
		expect(fetchFn).toHaveBeenCalledTimes(2);
		const init = fetchFn.mock.calls[0]![1] as { body: string; headers: Record<string, string> };
		expect(JSON.parse(init.body)).toEqual({ repositories: ["site"] });
		expect(init.headers.Authorization).toMatch(/^Bearer ey/);
	});

	it("sem app configurado devolve erro", async () => {
		const res = await getInstallationToken("11", { loadCredentials: async () => null });
		expect(res).toMatchObject({ error: expect.any(String), status: 503 });
	});
});

describe("getGithubToken: app primeiro, OAuth como reserva", () => {
	beforeEach(() => clearInstallationTokenCache());
	const inst = { id: "i1", userId: "u1", installationId: "11", accountLogin: "acme", accountType: "Organization", repositorySelection: "all", repositories: null, suspendedAt: null, createdAt: new Date() };
	const oauth = async () => ({ token: "gho_pessoal", login: "ali", source: "oauth" as const });

	it("repo coberto -> token do app", async () => {
		const now = Date.now();
		const fetchFn = vi.fn(async () => jsonResponse({ token: "ghs_app", expires_at: new Date(now + 3_600_000).toISOString() }, 201)) as unknown as typeof fetch;
		const res = await getGithubToken("u1", { repo: "acme/site", findInstallation: async () => inst, loadCredentials: async () => CREDS, fetchFn, fallback: oauth });
		expect(res).toMatchObject({ token: "ghs_app", source: "app", installationId: "11" });
	});
	it("repo não coberto, sem repo ou falha do token do app -> OAuth", async () => {
		const failing = vi.fn(async () => jsonResponse({ message: "boom" }, 500)) as unknown as typeof fetch;
		expect(await getGithubToken("u1", { repo: "x/y", findInstallation: async () => null, fallback: oauth })).toMatchObject({ source: "oauth", token: "gho_pessoal" });
		expect(await getGithubToken("u1", { fallback: oauth })).toMatchObject({ source: "oauth" });
		expect(await getGithubToken("u1", { repo: "acme/site", findInstallation: async () => inst, loadCredentials: async () => CREDS, fetchFn: failing, fallback: oauth })).toMatchObject({ source: "oauth" });
	});
	it("propaga o erro quando não há app nem OAuth", async () => {
		const res = await getGithubToken("u1", { repo: "x/y", findInstallation: async () => null, fallback: async () => ({ error: "Conecte o GitHub" }) });
		expect(res).toEqual({ error: "Conecte o GitHub" });
	});
});
