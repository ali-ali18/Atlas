import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
	getGithubWriteSettings: vi.fn(),
	listGithubInstallationsForUser: vi.fn(async () => []),
	findCoveringGithubInstallation: vi.fn(),
	getGithubAppConfigRecord: vi.fn(),
	saveGithubAppConfigRecord: vi.fn(),
	installationCoversRepo: (
		inst: { suspendedAt: Date | null; repositorySelection: string; accountLogin: string; repositories: Array<{ fullName: string }> | null },
		repo: string,
	) => {
		if (inst.suspendedAt) return false;
		const key = repo.toLowerCase();
		return inst.repositorySelection === "all"
			? inst.accountLogin.toLowerCase() === key.split("/")[0]
			: (inst.repositories ?? []).some((r) => r.fullName.toLowerCase() === key);
	},
}));

import type { GithubInstallationRecord } from "@workspace/db";
import { gateGithubWrite, isGithubWriteConnector, type GithubWriteGateDeps } from "./gate.js";
import { planGithubWrite, withGithubSignature } from "./ops.js";
import { GITHUB_APP_PERMISSIONS, missingGithubWritePermissions } from "../app/manifest.js";

const CREDS = { appId: "1", slug: "meu-app", name: "Meu App", privateKey: "pem", webhookSecret: "w", source: "db" as const };

function inst(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
	return {
		id: "row",
		userId: "u1",
		installationId: "555",
		accountLogin: "ali-ali18",
		accountType: "User",
		repositorySelection: "selected",
		repositories: [{ fullName: "ali-ali18/site", private: true }],
		suspendedAt: null,
		createdAt: new Date(0),
		...over,
	} as GithubInstallationRecord;
}

type Call = { url: string; method: string; auth: string | null; body: Record<string, unknown> | null };

function setup(
	over: { signature?: boolean; signatureText?: string | null; installs?: GithubInstallationRecord[]; creds?: typeof CREDS | null; status?: number; refreshed?: GithubInstallationRecord | null } = {},
) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({
			url,
			method: init.method ?? "GET",
			auth: new Headers(init.headers).get("authorization"),
			body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		});
		const status = over.status ?? 201;
		let body: Record<string, unknown> = { message: "Resource not accessible by integration" };
		if (status < 300) {
			body = { number: 7, html_url: "https://github.com/ali-ali18/site/issues/7", title: "t", sha: "abc123", object: { sha: "headsha" }, tree: { sha: "treesha" } };
		}
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	const deps: GithubWriteGateDeps = {
		loadSettings: async () => ({ signature: over.signature ?? false, signatureText: over.signatureText ?? null }),
		listInstallations: async () => over.installs ?? [inst()],
		loadCredentials: async () => (over.creds === undefined ? CREDS : over.creds),
		installationToken: async () => ({ token: "ghs_app", expiresAt: Date.now() + 3_600_000 }),
		refreshInstallation: async () => over.refreshed ?? null,
		fetchFn,
	};
	return { calls, deps };
}

const ISSUE = { method: "create", owner: "ali-ali18", repo: "site", title: "Bug", body: "texto", labels: ["bug"] };

describe("escritas no GitHub: sempre pelo app", () => {
	it("app instalado no repositório: cria a issue com o token de instalação (autor <app>[bot])", async () => {
		const { calls, deps } = setup();
		const out = await gateGithubWrite({ userId: "u1", toolName: "issue_write", args: ISSUE }, deps);
		expect(out.ok).toBe(true);
		expect(out.text).toContain("meu-app[bot]");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ url: "https://api.github.com/repos/ali-ali18/site/issues", method: "POST", auth: "Bearer ghs_app" });
		expect(calls[0]!.body).toMatchObject({ title: "Bug", labels: ["bug"] });
	});

	it("repositório fora da instalação: nada é enviado, volta o bloqueio com link para instalar", async () => {
		const { calls, deps } = setup();
		const out = await gateGithubWrite({ userId: "u1", toolName: "issue_write", args: { ...ISSUE, repo: "loja-monorepo" } }, deps);
		expect(out.ok).toBe(false);
		expect(out.githubIdentity).toMatchObject({ reason: "not_installed", repo: "ali-ali18/loja-monorepo", installUrl: "https://github.com/settings/installations/555" });
		expect(calls).toHaveLength(0);
	});

	it("depois que o usuário adiciona o repositório à instalação, a mesma chamada passa (relê a instalação)", async () => {
		const added = inst({ repositories: [{ fullName: "ali-ali18/site", private: true }, { fullName: "ali-ali18/loja-monorepo", private: true }] });
		const { calls, deps } = setup({ refreshed: added });
		const out = await gateGithubWrite({ userId: "u1", toolName: "issue_write", args: { ...ISSUE, repo: "loja-monorepo" } }, deps);
		expect(out.ok).toBe(true);
		expect(calls[0]!.url).toBe("https://api.github.com/repos/ali-ali18/loja-monorepo/issues");
	});

	it("sem instalação do dono do repositório: link do fluxo de instalação do app", async () => {
		const { deps } = setup({ installs: [] });
		const out = await gateGithubWrite({ userId: "u1", toolName: "add_issue_comment", args: { owner: "outra-org", repo: "x", issue_number: 1, body: "oi" } }, deps);
		expect(out.githubIdentity).toMatchObject({ reason: "not_installed", installUrl: "/v1/github-app/install" });
	});

	it("app nunca criado: bloqueia (cartão) em vez de usar a conta do usuário", async () => {
		const { deps } = setup({ creds: null });
		const out = await gateGithubWrite({ userId: "u1", toolName: "issue_write", args: ISSUE }, deps);
		expect(out.githubIdentity?.reason).toBe("app_missing");
	});

	it("instalação suspensa vira bloqueio, não escrita", async () => {
		const { calls, deps } = setup({ installs: [inst({ suspendedAt: new Date(1) })] });
		const out = await gateGithubWrite({ userId: "u1", toolName: "issue_write", args: ISSUE }, deps);
		expect(out.githubIdentity?.reason).toBe("suspended");
		expect(calls).toHaveLength(0);
	});

	it("403 do GitHub (app sem a permissão) pede para aceitar as novas permissões", async () => {
		const { deps } = setup({ status: 403 });
		const out = await gateGithubWrite({ userId: "u1", toolName: "issue_write", args: ISSUE }, deps);
		expect(out.githubIdentity?.reason).toBe("no_permission");
	});

	it("ação que o app não faz: erro claro ao bot, sem cartão e sem conta do usuário", async () => {
		const { calls, deps } = setup();
		const out = await gateGithubWrite({ userId: "u1", toolName: "create_repository", args: { name: "novo" } }, deps);
		expect(out.ok).toBe(false);
		expect(out.githubIdentity).toBeUndefined();
		expect(out.text).toContain("nunca é usada");
		expect(calls).toHaveLength(0);
	});

	it("fork pelo app: POST /forks com o token de instalação", async () => {
		const { calls, deps } = setup({ status: 202 });
		const out = await gateGithubWrite({ userId: "u1", toolName: "fork_repository", args: { owner: "ali-ali18", repo: "site", organization: "acme" } }, deps);
		expect(out.ok).toBe(true);
		expect(calls[0]).toMatchObject({ url: "https://api.github.com/repos/ali-ali18/site/forks", method: "POST", auth: "Bearer ghs_app" });
		expect(calls[0]!.body).toEqual({ organization: "acme" });
	});

	it("push_files pelo app: ref, commit base, árvore, commit e atualização da branch", async () => {
		const { calls, deps } = setup();
		const out = await gateGithubWrite(
			{ userId: "u1", toolName: "push_files", args: { owner: "ali-ali18", repo: "site", branch: "feat/x", message: "msg", files: [{ path: "a/b.txt", content: "oi" }] } },
			deps,
		);
		expect(out.ok).toBe(true);
		expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com/repos/ali-ali18/site", "")}`)).toEqual([
			"GET /git/ref/heads/feat/x",
			"GET /git/commits/headsha",
			"POST /git/trees",
			"POST /git/commits",
			"PATCH /git/refs/heads/feat/x",
		]);
		expect(calls[2]!.body).toMatchObject({ base_tree: "treesha", tree: [{ path: "a/b.txt", content: "oi" }] });
		expect(calls.every((c) => c.auth === "Bearer ghs_app")).toBe(true);
	});

	it("assinatura opcional: padrão desligada; ligada acrescenta o rodapé", async () => {
		const comment = { owner: "ali-ali18", repo: "site", issue_number: 3, body: "oi" };
		const off = setup();
		await gateGithubWrite({ userId: "u1", toolName: "add_issue_comment", args: comment }, off.deps);
		expect(off.calls[0]!.body).toEqual({ body: "oi" });
		const on = setup({ signature: true });
		await gateGithubWrite({ userId: "u1", toolName: "add_issue_comment", args: comment, botName: "Cookie" }, on.deps);
		expect(on.calls[0]!.body).toEqual({ body: "oi\n\n---\n<sub>— enviado pelo bot Cookie</sub>" });
		const custom = setup({ signature: true, signatureText: "via bot" });
		await gateGithubWrite({ userId: "u1", toolName: "add_issue_comment", args: comment }, custom.deps);
		expect(custom.calls[0]!.body).toEqual({ body: "oi\n\n---\n<sub>— via bot</sub>" });
	});

	it("rodapé não se repete", () => {
		const once = withGithubSignature("a", "bot");
		expect(withGithubSignature(once, "bot")).toBe(once);
	});
});

describe("mapeamento das ferramentas de escrita", () => {
	it("cobre issue, comentário, PR, review, edição e labels", () => {
		const cases: Array<[string, Record<string, unknown>]> = [
			["issue_write", { method: "update", owner: "a", repo: "b", issue_number: 2, labels: ["x"] }],
			["add_issue_comment", { owner: "a", repo: "b", issue_number: 2, body: "x" }],
			["create_pull_request", { owner: "a", repo: "b", title: "t", head: "h", base: "main" }],
			["update_pull_request", { owner: "a", repo: "b", pullNumber: 4, title: "t" }],
			["pull_request_review_write", { method: "create", owner: "a", repo: "b", pullNumber: 4, body: "ok", event: "APPROVE" }],
			["GITHUB_CREATE_AN_ISSUE", { owner: "a", repo: "b", title: "t" }],
		];
		for (const [tool, args] of cases) expect(planGithubWrite(tool, args).plan).not.toBeNull();
		expect(planGithubWrite("fork_repository", { owner: "a", repo: "b" }).plan).not.toBeNull();
		expect(planGithubWrite("create_repository", { name: "b" }).plan).toBeNull();
	});

	it("reconhece só conector GitHub (nativo ou Composio)", () => {
		expect(isGithubWriteConnector("github", "issue_write")).toBe(true);
		expect(isGithubWriteConnector("composio", "GITHUB_CREATE_AN_ISSUE")).toBe(true);
		expect(isGithubWriteConnector("composio", "GMAIL_SEND")).toBe(false);
		expect(isGithubWriteConnector("notion", "create_page")).toBe(false);
	});
});

describe("manifest do app", () => {
	it("pede issues, pull requests e contents com escrita e metadata com leitura", () => {
		expect(GITHUB_APP_PERMISSIONS).toMatchObject({ issues: "write", pull_requests: "write", contents: "write", metadata: "read" });
	});
	it("detecta app antigo sem escrita em issues", () => {
		expect(missingGithubWritePermissions({ issues: "read", pull_requests: "write", contents: "write" })).toEqual(["issues"]);
		expect(missingGithubWritePermissions({ issues: "write", pull_requests: "write", contents: "write" })).toEqual([]);
		expect(missingGithubWritePermissions(null)).toEqual([]);
	});
});
