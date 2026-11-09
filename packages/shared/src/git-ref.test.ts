import { describe, expect, it } from "vitest";
import { isSafeGithubRepo, isSafeGitRef } from "./git-ref.js";

describe("isSafeGitRef", () => {
	it("aceita branch, tag e SHA comuns", () => {
		for (const ok of ["main", "feature/x", "v1.2.3", "release/0.3.0-beta", "a".repeat(40)]) expect(isSafeGitRef(ok)).toBe(true);
	});
	it("recusa `..`, barra nas pontas, vazio, longo e caracteres proibidos", () => {
		for (const bad of ["", "a..b", "/x", "x/", "a//b", "/../../user/emails", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a#b", "a\nb", "x.lock", "a@{1}", ".hidden", "a/.b", "x".repeat(201)]) expect(isSafeGitRef(bad)).toBe(false);
	});
});

describe("isSafeGithubRepo", () => {
	it("owner/name, sem segmento `.` ou `..`", () => {
		expect(isSafeGithubRepo("acme/site")).toBe(true);
		for (const bad of ["acme", "a/b/c", "../user", "acme/..", "./x", "acme/", "a b/c"]) expect(isSafeGithubRepo(bad)).toBe(false);
	});
});
