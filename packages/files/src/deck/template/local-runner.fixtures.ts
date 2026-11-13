import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodeRunInput, CodeRunResult } from "@workspace/sandbox";

/** python3 com python-pptx instalado? Sem isso os testes que preenchem o modelo de verdade são pulados. */
export const HAS_PYTHON_PPTX = spawnSync("python3", ["-I", "-c", "import pptx, PIL, lxml"], { stdio: "ignore" }).status === 0;
export const HAS_SOFFICE = spawnSync("soffice", ["--version"], { stdio: "ignore" }).status === 0 && spawnSync("pdftoppm", ["-v"], { stdio: "ignore" }).status === 0;

/** Executor local no lugar do container `run_code`: mesma convenção de pastas (in/, out/, preview/). */
export async function runPythonLocally(input: CodeRunInput): Promise<CodeRunResult> {
	const work = mkdtempSync(path.join(tmpdir(), "deck-run-"));
	try {
		mkdirSync(path.join(work, "in"));
		for (const file of input.files ?? []) writeFileSync(path.join(work, "in", file.name), file.bytes);
		writeFileSync(path.join(work, "main.py"), input.code);
		const started = Date.now();
		const run = spawnSync("python3", ["-I", "main.py"], { cwd: work, env: { ...process.env, ATLAS_WORK: work }, encoding: "utf8", timeout: (input.timeoutSec ?? 60) * 1000 });
		const list = (dir: string) => {
			try {
				return readdirSync(path.join(work, dir)).map((name) => ({ name, bytes: new Uint8Array(readFileSync(path.join(work, dir, name))) }));
			} catch {
				return [];
			}
		};
		return {
			exitCode: run.status,
			timedOut: run.error !== undefined,
			stdout: run.stdout ?? "",
			stderr: run.stderr ?? "",
			truncated: false,
			durationMs: Date.now() - started,
			outputs: list("out"),
			previews: list("preview"),
			omitted: [],
			inputNames: (input.files ?? []).map((f) => f.name),
			crashed: false,
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
