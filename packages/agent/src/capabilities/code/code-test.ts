// `code_test` (F8.2): roda um teste focado e devolve a saída. A suíte completa de um monorepo só roda com `fullSuite: true`,
// que o modelo declara quando o dono pediu (sinal estruturado, não regex sobre a fala). Mesmo portão do shell.
import { fullSuiteAdvice, redactSecrets } from "@workspace/shared";
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { callCode } from "./call.js";
import { classifyShell, fullSuiteOf, isTestCommand, shellEffect } from "./command-gate.js";
import { codeResults } from "./kinds.js";
import { describeRun } from "./shell-output.js";

export function createCodeTestTool() {
	return defineTool({
		name: "code_test",
		description:
			"Run a FOCUSED test in the coding workspace (e.g. `pnpm exec vitest run path/to/file.test.ts`, `pytest tests/test_x.py`, `go test ./pkg`). Use it after an edit to prove the fix. " +
			"Run only the tests that cover your change. Set fullSuite: true ONLY when the owner explicitly asked for the whole suite. Do not use it for other commands (code_shell).",
		inputSchema: z.object({
			sessionId: z.string().min(1).max(100),
			cmd: z.string().min(1).max(100_000),
			cwd: z.string().max(500).optional(),
			timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
			fullSuite: z.boolean().optional().describe("true only when the owner asked for the whole test suite."),
		}),
		effect: "write_internal",
		effectForArgs: ({ cmd }) => shellEffect(classifyShell(cmd)),
		riskFacts: ({ cmd }) => ({ target: redactSecrets(cmd).slice(0, 400) }),
		trust: "untrusted",
		source: "file",
		async execute({ fullSuite, ...args }, ctx) {
			const cls = classifyShell(args.cmd);
			if (cls.kind === "deny") throw new Error(`Refused: ${cls.reason}.`);
			const whole = fullSuiteOf(args.cmd);
			if (whole && fullSuite !== true) throw new Error(fullSuiteAdvice(whole));
			if (!whole && !isTestCommand(args.cmd)) throw new Error("This is not a test command. Use code_test for test runs only (pnpm test, vitest, jest, pytest, go test, cargo test…); use code_shell for other commands.");
			const run = await callCode(ctx, "test", { ...args, ...(fullSuite === true && { fullSuite: true }) }, codeResults.shell);
			const verdict = run.timedOut ? "TIMED OUT" : run.exitCode === 0 ? "PASSED" : "FAILED";
			return { ok: true, summary: `Tests ${verdict}.\n${describeRun("Test command", run)}`, receipt: { what: `Ran tests (${verdict.toLowerCase()})`, where: "coding workspace" } };
		},
	});
}
