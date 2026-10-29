import { describe, expect, it } from "vitest";
import { createDevVerificationTracker, isVerificationCommand } from "./dev-verification.js";

describe("isVerificationCommand", () => {
	it.each([
		"pnpm test",
		"pnpm --filter @workspace/shared test",
		"pnpm -F api run typecheck",
		"pnpm run lint:fix",
		"npm run build",
		"npm test -- --watch=false",
		"yarn test",
		"pnpm exec vitest run src/a.test.ts",
		"npx tsc --noEmit",
		"cd packages/a && pnpm exec tsc --noEmit",
		"NODE_ENV=test pnpm exec tsx --test src/a.test.ts",
		"pnpm exec turbo typecheck",
		"turbo run test --filter=api",
		"pytest -q tests/",
		"cargo test -p core",
		"go test ./...",
		"make test",
		"ruff check .",
		"pnpm exec biome check src",
	])("reconhece %s", (cmd) => expect(isVerificationCommand(cmd)).toBe(true));

	it.each(["pnpm install", "git status", "ls -la", "cat package.json", "pnpm dev", "pnpm add zod", "npm run dev", "echo test", "git commit -m 'test: x'", "{bad"])(
		"ignora %s",
		(cmd) => expect(isVerificationCommand(cmd)).toBe(false),
	);

	it.each([
		"pnpm test 2>&1 | tail -30",
		"pnpm test | head",
		"pnpm test || true",
		"pnpm test; echo done",
		"pnpm test & echo x",
		"false || pnpm test",
		"pnpm test && echo ok; echo done",
	])("não conta quando o status é mascarado: %s", (cmd) => expect(isVerificationCommand(cmd)).toBe(false));

	it.each([
		"cd packages/a && pnpm test",
		"pnpm test 2>&1",
		"pnpm test && echo ok",
		"set -o pipefail; pnpm test | tail -30",
		"echo x; pnpm test",
		"pnpm test 2>&1 && pnpm build",
		'pnpm exec vitest run -t "a || b"',
	])("conta quando o status chega ao exit code: %s", (cmd) => expect(isVerificationCommand(cmd)).toBe(true));

	it("o comando de teste do ambiente também vale", () => {
		expect(isVerificationCommand("./scripts/check-all.sh --fast")).toBe(false);
		expect(isVerificationCommand("./scripts/check-all.sh --fast", "./scripts/check-all.sh")).toBe(true);
	});
});

const edited = (path: string) => ({ name: "edit_file", args: { path }, ok: true, summary: `Editado ${path} (+1 -1).` });
const shell = (cmd: string, summary: string, ok = true) => ({ name: "shell", args: { cmd }, ok, summary });

describe("createDevVerificationTracker", () => {
	it("edição sem verificação pede trabalho; teste que passa limpa", async () => {
		const tracker = createDevVerificationTracker();
		expect(tracker.needsMoreWork()).toBe(false);
		await tracker.note(edited("a.ts"));
		await tracker.note({ name: "write_file", args: { path: "b.ts" }, ok: true, summary: "Criado b.ts" });
		expect(tracker.hasUnverifiedEdits()).toBe(true);
		await tracker.note(shell("pnpm test", "exit 1 em 2.0s (cwd /workspace)\n[stdout]\n1 failed"));
		expect(tracker.hasUnverifiedEdits()).toBe(true);
		await tracker.note(shell("git status", "exit 0 em 0.1s (cwd /workspace)"));
		expect(tracker.hasUnverifiedEdits()).toBe(true);
		await tracker.note(shell("pnpm test", "exit 0 em 2.0s (cwd /workspace)\n[stdout]\nok"));
		expect(tracker.hasUnverifiedEdits()).toBe(false);
		expect(tracker.needsMoreWork()).toBe(false);
	});

	it("edição depois da verificação volta a contar; falha e escrita pendente de aprovação não", async () => {
		const tracker = createDevVerificationTracker();
		await tracker.note(shell("pnpm test", "exit 0 em 1.0s (cwd /workspace)"));
		await tracker.note({ name: "edit_file", args: { path: "a.ts" }, ok: false, summary: "old não foi encontrado" });
		await tracker.note({ name: "edit_file", args: { path: "a.ts" }, ok: true, summary: "Aprovação pendente (edição de a.ts). Nada foi executado ainda." });
		expect(tracker.hasUnverifiedEdits()).toBe(false);
		await tracker.note(edited("a.ts"));
		expect(tracker.hasUnverifiedEdits()).toBe(true);
	});

	it("verificação em segundo plano: roda = ainda pede trabalho; terminou com exit 0 = limpa só o que veio antes", async () => {
		const tracker = createDevVerificationTracker();
		await tracker.note(edited("a.ts"));
		await tracker.note(shell("pnpm test", "Comando iniciado em segundo plano: job_id=0123456789ab. Acompanhe com shell_output"));
		await tracker.note(edited("b.ts"));
		expect(tracker.hasRunningVerification()).toBe(true);
		await tracker.note({ name: "shell_output", args: { jobId: "0123456789ab" }, ok: true, summary: "job 0123456789ab: rodando (3.0s)" });
		expect(tracker.hasRunningVerification()).toBe(true);
		await tracker.note({ name: "shell_output", args: { jobId: "0123456789ab" }, ok: true, summary: "job 0123456789ab: terminou (exit 0) em 9.0s" });
		expect(tracker.hasRunningVerification()).toBe(false);
		// b.ts foi editado depois de o job começar: continua sem verificar.
		expect(tracker.hasUnverifiedEdits()).toBe(true);
	});

	it("servidor de desenvolvimento em segundo plano não é verificação", async () => {
		const tracker = createDevVerificationTracker();
		await tracker.note(shell("pnpm dev", "Comando iniciado em segundo plano: job_id=0123456789ab. Acompanhe"));
		expect(tracker.needsMoreWork()).toBe(false);
	});

	it("shell_kill encerra o job; testCommand do ambiente é lido só para comando desconhecido", async () => {
		let reads = 0;
		const tracker = createDevVerificationTracker({ getTestCommand: async () => (reads++, "./run-checks.sh") });
		await tracker.note(shell("pnpm test", "Comando iniciado em segundo plano: job_id=aaaaaaaaaaaa."));
		expect(reads).toBe(0);
		await tracker.note({ name: "shell_kill", args: { jobId: "aaaaaaaaaaaa" }, ok: true, summary: "Sinal enviado" });
		expect(tracker.hasRunningVerification()).toBe(false);
		await tracker.note(edited("a.ts"));
		await tracker.note(shell("./run-checks.sh --fast", "exit 0 em 1.0s (cwd /workspace)"));
		expect(reads).toBe(1);
		expect(tracker.hasUnverifiedEdits()).toBe(false);
	});
});
