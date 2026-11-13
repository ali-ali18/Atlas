import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ listGithubInstallationsForUser: vi.fn(async () => []) }));

import type { GithubInstallationRecord } from "@workspace/db";
import { fetchCompare } from "./app/compare.js";
import { createAppGithubReadOps } from "./read-ops.js";

const inst = {
	id: "i1",
	userId: "u1",
	installationId: "11",
	accountLogin: "acme",
	accountType: "Organization",
	repositorySelection: "selected",
	repositories: [{ fullName: "acme/site", private: true }],
	suspendedAt: null,
	createdAt: new Date(),
} as unknown as GithubInstallationRecord;

describe("createAppGithubReadOps.listRepos", () => {
	it("S12: a instalação não informa a branch padrão, então não inventa main", async () => {
		const ops = createAppGithubReadOps([inst], { getInstallationToken: vi.fn(async () => ({ token: "ghs", expiresAt: 0 })) });
		const res = await ops.listRepos();
		expect(res.data).toEqual([{ fullName: "acme/site", private: true, defaultBranch: null, pushedAt: null }]);
	});
});

describe("fetchCompare", () => {
	it("S11: ref ou repo com `..` não chega à rede", async () => {
		const fetchFn = vi.fn();
		const bad = await fetchCompare({ token: "t", repo: "acme/site", base: "main", head: "/../../user/emails", fetchFn: fetchFn as never });
		expect(bad.error?.status).toBe(400);
		expect((await fetchCompare({ token: "t", repo: "acme/..", base: "a", head: "b", fetchFn: fetchFn as never })).error?.status).toBe(400);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
