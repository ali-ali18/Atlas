import { describe, expect, it } from "vitest";
import { buildInfo, resolveCommit, shortCommit } from "./build-info.js";
import { envGroupStatus, formatMissingEnv, missingEnvGroups } from "./env-check.js";

describe("env-check", () => {
	it("agrupa o que falta por recurso, sem valores", () => {
		const lines = formatMissingEnv({ OPENROUTER_API_KEY: "sk-secret-value-123456" }, "worker");
		expect(lines.some((line) => line.includes("Notificações push") && line.includes("WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_SUBJECT"))).toBe(true);
		expect(lines.some((line) => line.includes("OpenRouter"))).toBe(false);
		expect(lines.join("\n")).not.toContain("sk-secret-value");
	});

	it("api tem grupos que o worker não lê (OAuth) e vice-versa não repete", () => {
		const api = missingEnvGroups({}, "api").map((g) => g.group.id);
		const worker = missingEnvGroups({}, "worker").map((g) => g.group.id);
		expect(api).toContain("github-oauth");
		expect(worker).not.toContain("github-oauth");
	});

	it("anyOf: uma chave de pesquisa basta", () => {
		expect(missingEnvGroups({ FIRECRAWL_API_KEY: "x" }, "api").map((g) => g.group.id)).not.toContain("search");
		expect(missingEnvGroups({}, "api").map((g) => g.group.id)).toContain("search");
	});

	it("valor em branco conta como ausente", () => {
		expect(missingEnvGroups({ SENTRY_DSN: "   " }, "api").map((g) => g.group.id)).toContain("observability");
	});

	it("status por recurso não vaza valores", () => {
		const status = envGroupStatus({ WEB_PUSH_PUBLIC_KEY: "pub", WEB_PUSH_PRIVATE_KEY: "priv", WEB_PUSH_SUBJECT: "mailto:a@b.c" });
		expect(status.find((s) => s.id === "push")).toEqual({ id: "push", label: "Notificações push (Web Push/VAPID)", configured: true, missing: [] });
		expect(JSON.stringify(status)).not.toContain("priv");
	});
});

describe("build-info", () => {
	it("commit: ATLAS_COMMIT, depois alternativas, senão vazio", () => {
		expect(resolveCommit({ ATLAS_COMMIT: "abc123" })).toBe("abc123");
		expect(resolveCommit({ SOURCE_COMMIT: "def456" })).toBe("def456");
		expect(resolveCommit({})).toBe("");
		expect(shortCommit("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
		expect(buildInfo("api", { ATLAS_COMMIT: "0123456789abcdef0123456789abcdef01234567" }, new Date("2026-01-01T00:00:00Z"))).toMatchObject({ service: "api", version: "", commitShort: "0123456", startedAt: "2026-01-01T00:00:00.000Z" });
	});
});
