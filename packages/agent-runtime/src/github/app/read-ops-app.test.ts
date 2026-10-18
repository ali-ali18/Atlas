import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
	findCoveringGithubInstallation: vi.fn(),
	listGithubInstallationsForUser: vi.fn(async () => []),
	getGithubAppConfigRecord: vi.fn(),
	saveGithubAppConfigRecord: vi.fn(),
}));

import { createAppGithubReadOps, resolveGithubReadOps } from "../read-ops.js";
import type { GithubInstallationRecord } from "@workspace/db";

const inst = (over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord => ({
	id: "i1",
	userId: "u1",
	installationId: "11",
	accountLogin: "acme",
	accountType: "Organization",
	repositorySelection: "selected",
	repositories: [{ fullName: "acme/site", private: true }],
	suspendedAt: null,
	createdAt: new Date(),
	...over,
});

describe("resolveGithubReadOps com o GitHub App", () => {
	it("repo coberto -> ops com source app (sem tocar no OAuth)", async () => {
		const getToken = vi.fn(async () => ({ token: "gho", source: "oauth" as const }));
		const getAppToken = vi.fn(async () => ({ token: "ghs_app", login: "acme", source: "app" as const, installationId: "11" }));
		const res = await resolveGithubReadOps("u1", { repo: "acme/site" }, { getToken, getAppToken, getComposioContext: async () => null });
		if (!("ops" in res)) throw new Error("sem ops");
		expect(res.ops.source).toBe("app");
		expect(getAppToken).toHaveBeenCalledWith("u1", expect.objectContaining({ repo: "acme/site" }));
	});

	it("sem repo continua usando o token pessoal (compat)", async () => {
		const getToken = vi.fn(async () => ({ token: "gho", source: "oauth" as const }));
		const getAppToken = vi.fn();
		const res = await resolveGithubReadOps("u1", {}, { getToken, getAppToken: getAppToken as never, getComposioContext: async () => null });
		if (!("ops" in res)) throw new Error("sem ops");
		expect(res.ops.source).toBe("native");
		expect(getAppToken).not.toHaveBeenCalled();
	});

	it("sem OAuth nem Composio, mas com instalação -> ops só do app", async () => {
		const res = await resolveGithubReadOps(
			"u1",
			{},
			{ getToken: async () => ({ error: "Conecte" }), getComposioContext: async () => null, listInstallations: async () => [inst()] },
		);
		if (!("ops" in res)) throw new Error("sem ops");
		expect(res.ops.source).toBe("app");
		const repos = await res.ops.listRepos();
		expect(repos.data?.map((r) => r.fullName)).toEqual(["acme/site"]);
	});

	it("sem nada -> erro de conexão", async () => {
		const res = await resolveGithubReadOps("u1", {}, { getToken: async () => ({ error: "Conecte o GitHub" }), getComposioContext: async () => null, listInstallations: async () => [] });
		expect(res).toEqual({ error: "Conecte o GitHub" });
	});
});

describe("createAppGithubReadOps", () => {
	it("repo fora da instalação -> 404; suspensa não conta", async () => {
		const tokenFor = vi.fn(async () => ({ token: "ghs", expiresAt: 0 }));
		const ops = createAppGithubReadOps([inst()], { getInstallationToken: tokenFor });
		const miss = await ops.listPulls("acme/outro");
		expect(miss.error?.status).toBe(404);
		expect(tokenFor).not.toHaveBeenCalled();
		const sus = createAppGithubReadOps([inst({ suspendedAt: new Date() })], { getInstallationToken: tokenFor });
		expect((await sus.compare("acme/site", "a", "b")).error?.status).toBe(404);
	});
});
