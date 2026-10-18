import { describe, expect, it } from "vitest";
import { detectFullSuiteTest, fullSuiteAdvice, isFullSuiteTestCommand, userAskedForFullSuite } from "./dev-command-approval.js";

describe("detectFullSuiteTest", () => {
	const full = [
		"pnpm -r test",
		"pnpm -r --no-bail test",
		"pnpm --recursive test",
		"pnpm -r run test",
		"pnpm -r test:unit",
		"CI=1 pnpm -r test",
		"cd repo && pnpm -r test 2>&1 | tail -20",
		"turbo test",
		"turbo run test",
		"turbo run test lint",
		"pnpm turbo test",
		"pnpm exec turbo run test",
		"npx turbo run test",
		"npm test --workspaces",
		"npm run test --workspaces --if-present",
		"npm test -ws",
		"yarn workspaces run test",
		"yarn workspaces foreach -A run test",
		"nx run-many -t test",
		"nx run-many --target=test",
		"nx run-many --target test --parallel=2",
	];
	for (const cmd of full) {
		it(`reconhece: ${cmd}`, () => {
			expect(detectFullSuiteTest(cmd)).not.toBeNull();
		});
	}

	const scoped = [
		"pnpm --filter @app/api test",
		"pnpm -r --filter ./packages/shared test",
		"pnpm -F web test",
		"pnpm -C apps/api test:unit",
		"pnpm --filter=@app/api test",
		"pnpm test:unit",
		"pnpm build",
		"pnpm -r build",
		"pnpm -r typecheck",
		"turbo test --filter=@app/api",
		"turbo run test --affected",
		"turbo build",
		"npm test",
		"npm test --workspace=packages/a",
		"npm test -w packages/a",
		"yarn test",
		"yarn workspace @app/a test",
		"nx run-many -t test -p api",
		"nx run-many -t build",
		"nx test api",
		"vitest run src/a.test.ts",
		"echo pnpm -r test",
	];
	for (const cmd of scoped) {
		it(`deixa passar: ${cmd}`, () => {
			expect(isFullSuiteTestCommand(cmd, { rootIsWorkspace: true })).toBeNull();
		});
	}

	it("pnpm test só conta na raiz de um workspace", () => {
		expect(detectFullSuiteTest("pnpm test")?.rootScript).toBe(true);
		expect(isFullSuiteTestCommand("pnpm test", { rootIsWorkspace: false })).toBeNull();
		expect(isFullSuiteTestCommand("pnpm test", {})).toBeNull();
		expect(isFullSuiteTestCommand("pnpm test", { rootIsWorkspace: true })).not.toBeNull();
		expect(isFullSuiteTestCommand("pnpm run test", { rootIsWorkspace: true })).not.toBeNull();
		expect(isFullSuiteTestCommand("pnpm -r test", { rootIsWorkspace: false })).not.toBeNull();
	});
	it("comando que não dá para entender não é barrado", () => {
		expect(detectFullSuiteTest("")).toBeNull();
	});
});

describe("userAskedForFullSuite", () => {
	it("reconhece pedidos explícitos", () => {
		for (const text of ["rode todos os testes", "roda a suíte inteira", "SUITE COMPLETA por favor", "quero ver tudo passando", "run the full suite", "run all tests", "Rode a suíte toda"]) {
			expect(userAskedForFullSuite([text]), text).toBe(true);
		}
	});
	it("não confunde com pedidos comuns", () => {
		for (const text of ["corrija o login", "rode o teste do pacote api", "conserte o teste que falhou", "o fullstack está quebrado", "tudoo bem"]) {
			expect(userAskedForFullSuite([text]), text).toBe(false);
		}
		expect(userAskedForFullSuite([])).toBe(false);
	});
	it("vale qualquer fala recente", () => {
		expect(userAskedForFullSuite(["oi", "rode todos os testes", "valeu"])).toBe(true);
	});
});

describe("fullSuiteAdvice", () => {
	it("aponta o comando rápido do ambiente ou os pacotes alterados", () => {
		const match = detectFullSuiteTest("pnpm -r test")!;
		expect(fullSuiteAdvice(match, "pnpm --filter @app/api test")).toContain("`pnpm --filter @app/api test`");
		const generic = fullSuiteAdvice(match, null);
		expect(generic).toContain("git diff --name-only");
		expect(generic).toContain("pnpm --filter <pacote> test");
		expect(generic).not.toContain("Atlas");
	});
});
