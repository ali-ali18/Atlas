import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeCodeSandbox, type FakeCodeExec } from "@workspace/agent";

/**
 * Sandbox de código do eval do motor v4 (F8.2): um repositório fixture REAL em disco (`fixtures/code/<nome>`) carregado num
 * `FakeCodeSandbox`. Ler, listar, editar (com o casamento da VM) e o diff são em memória; comando e teste rodam DE VERDADE
 * numa cópia temporária (`sh -c`, `node --test`), então o teste que falha antes e passa depois é de verdade. Sem rede.
 * Só comandos de leitura e de teste rodam: o eval não é um shell aberto (o portão da capacidade já filtra antes, isto é a 2ª trava).
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/code/", import.meta.url));
const RUNNABLE = ["pnpm test", "pnpm run test", "npm test", "node --test", "pnpm exec vitest", "ls", "cat ", "head ", "git status", "git diff", "git log", "rg ", "grep ", "pwd"];
const TIMEOUT_MS = 30_000;

async function readTree(root: string, dir = root): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) Object.assign(out, await readTree(root, full));
		else out[relative(root, full)] = await readFile(full, "utf8");
	}
	return out;
}

/** Roda o comando numa cópia temporária dos arquivos da sessão e devolve a saída real. */
export const runInTempCopy: FakeCodeExec = async ({ cmd, cwd, files }) => {
	if (!RUNNABLE.some((prefix) => cmd.trim().startsWith(prefix))) return { exitCode: 126, output: `The eval environment does not run this command: ${cmd}` };
	const dir = await mkdtemp(join(tmpdir(), "atlas-eval-code-"));
	try {
		for (const [path, text] of files) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), text);
		}
		return await new Promise((resolve) => {
			const child = spawn("sh", ["-c", cmd], { cwd: cwd?.startsWith("/workspace") ? join(dir, cwd.slice("/workspace".length)) : dir, env: { PATH: process.env.PATH ?? "", HOME: dir, NO_COLOR: "1" } });
			let output = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
			child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
			child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				resolve({ exitCode: code, output, ...(signal === "SIGKILL" && { timedOut: true }) });
			});
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

export async function createFixtureCodeSandbox(name: string): Promise<FakeCodeSandbox> {
	if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`fixture de código inválida: ${name}`);
	const seed = await readTree(join(FIXTURES, name));
	return new FakeCodeSandbox({ seed, exec: runInTempCopy, testCommand: "pnpm test" });
}
