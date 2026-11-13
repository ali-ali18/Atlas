import { describe, expect, it } from "vitest";
import { GITHUB_APP_PERMISSIONS, missingGithubWritePermissions } from "../app/manifest.js";

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
