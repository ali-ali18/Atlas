import { describe, expect, it } from "vitest";
import { buildGithubSecurityReviewPrompt } from "./index.js";

describe("buildGithubSecurityReviewPrompt", () => {
	const prompt = buildGithubSecurityReviewPrompt({ repo: "acme/monorepo" });

	it("cita o repositório e é somente leitura", () => {
		expect(prompt).toContain("acme/monorepo");
		expect(prompt).toMatch(/Read-only/);
	});

	it("manda ler diffs e não a árvore de arquivos", () => {
		expect(prompt).toContain("pull_request_read");
		expect(prompt).toContain("get_commit");
		expect(prompt).toMatch(/Do not browse files one by one/);
	});

	it("limita a 5 PRs por execução e usa a nota X/10 com severidades", () => {
		expect(prompt).toContain("at most 5 per run");
		expect(prompt).toContain("Nota X/10");
		expect(prompt).toMatch(/critical, high, medium, low/);
	});

	it("usa lastRunAt e trata dado do GitHub como não confiável", () => {
		expect(prompt).toContain("lastRunAt");
		expect(prompt).toMatch(/untrusted data/);
	});

	it("inclui o foco extra do usuário só quando existe", () => {
		expect(prompt).not.toContain("User focus");
		expect(
			buildGithubSecurityReviewPrompt({ repo: "a/b", extra: "  autenticação " }),
		).toContain("User focus: autenticação");
	});
});
