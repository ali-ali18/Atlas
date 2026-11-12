import { describe, expect, it } from "vitest";
import { isSafeGitRef } from "./git-ref.js";
import { classifyCommitPaths, isSensitiveCommitFile } from "./git-commit-guard.js";

describe("isSensitiveCommitFile", () => {
	it("pega os .env de sempre e as chaves e credenciais que a lista curta deixava passar", () => {
		for (const bad of [
			".env", "apps/api/.env.local", "certs/site.pem", "deploy/server.key", "keys/cert.p12", "cert.pfx", "android/release.keystore", "credentials.json", "gcp/service-account-prod.json", "serviceaccount.json",
			".pypirc", ".docker/config.json", "home/.docker/config.json", ".htpasswd", "infra/terraform.tfstate", "infra/prod.tfvars", "id_rsa", ".aws/credentials", ".kube/config", "vault.kdbx",
		]) expect(isSensitiveCommitFile(bad), bad).toBe(true);
	});
	it("não pega o que é só exemplo ou código comum", () => {
		for (const ok of [".env.example", "src/keys.ts", "docs/key-rotation.md", "src/credentials-form.tsx", "package.json", "id_rsa.pub", "monkey.json", "service-accounts.md"]) expect(isSensitiveCommitFile(ok), ok).toBe(false);
	});
	it("o caminho que o git imprime com aspas e escapes octais (quotePath) também vale", () => {
		expect(isSensitiveCommitFile('"d\\303\\251/.env"')).toBe(true);
		expect(isSensitiveCommitFile("dé/.env")).toBe(true);
	});
});

describe("classifyCommitPaths", () => {
	it("separa segredo de caminho que muda o que roda no GitHub ou na máquina do dono (CI, hooks)", () => {
		const out = classifyCommitPaths(["src/a.ts", "apps/x/.env", ".github/workflows/deploy.yml", ".husky/pre-commit", ".githooks/pre-push", "pkg/.husky/x", "deploy/ca.pem"]);
		expect(out.secrets).toEqual(["apps/x/.env", "deploy/ca.pem"]);
		expect(out.guarded).toEqual([".github/workflows/deploy.yml", ".husky/pre-commit", ".githooks/pre-push", "pkg/.husky/x"]);
	});
	it("lista limpa devolve vazio; .github que não é workflow nem action passa", () => {
		expect(classifyCommitPaths(["src/a.ts", ".github/ISSUE_TEMPLATE/bug.md", ".github/CODEOWNERS"])).toEqual({ secrets: [], guarded: [] });
	});
});

describe("isSafeGitRef: segmento iniciando com hífen", () => {
	it("recusa `-x`, `a/-b` e `--upload-pack=...` (ia virar opção do git)", () => {
		for (const bad of ["-x", "a/-b", "--upload-pack=touch", "-"]) expect(isSafeGitRef(bad), bad).toBe(false);
		expect(isSafeGitRef("fix/a-b")).toBe(true);
	});
});
