import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, parseCliArgs } from "../cli.js";
import { assertKeysFor } from "./index.js";

/** CLI da avaliação da ponte: `--suite bridge`, chaves só do ambiente (nunca impressas), saída em arquivos e a estimativa de custo. */

const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI", () => {
	it("--suite bridge é o comando bridge", () => {
		expect(parseCliArgs(["--suite", "bridge", "--engine", "v3", "--models", "a,b", "--repeat", "3", "--max-cost", "5"]).command).toBe("bridge");
		expect(parseCliArgs(["bridge", "--mock"]).command).toBe("bridge");
		expect(parseCliArgs(["--mock"]).command).toBe("run");
	});

	it("sem chave no ambiente falha claro, com o nome da variável e sem valor", () => {
		expect(() => assertKeysFor(["deepseek/deepseek-chat"], {})).toThrow(/OPENROUTER_API_KEY/);
		expect(() => assertKeysFor(["opencode-go/kimi-k2"], { OPENROUTER_API_KEY: "sk-or-segredo" })).toThrow(/OPENCODE_GO_API_KEY/);
		expect(() => assertKeysFor(["chatgpt/gpt-5"], { OPENROUTER_API_KEY: "sk-or-segredo" })).toThrow(/OAuth|slug do OpenRouter/);
		let message = "";
		try {
			assertKeysFor(["opencode-go/kimi-k2"], { OPENROUTER_API_KEY: "sk-or-segredo" });
		} catch (error) {
			message = String(error);
		}
		expect(message).not.toContain("sk-or-segredo");
		expect(() => assertKeysFor(["deepseek/deepseek-chat", "opencode-go/kimi-k2"], { OPENROUTER_API_KEY: "x", OPENCODE_GO_API_KEY: "y" })).not.toThrow();
	});

	it("bridge --mock grava report.md, results.json e runs.jsonl", async () => {
		const out = await mkdtemp(join(tmpdir(), "evals-bridge-"));
		dirs.push(out);
		const code = await main(["bridge", "--mock", "--only", "criar-bot,cofre-pt-br", "--out", out]);
		expect(code).toBe(0);
		expect(await readFile(join(out, "report.md"), "utf8")).toContain("| criar-bot |");
		const results = JSON.parse(await readFile(join(out, "results.json"), "utf8")) as { report: { decision: { kind: string } }; runs: unknown[] };
		expect(results.runs).toHaveLength(4);
		expect(results.report.decision.kind).toBe("ponte-aprovada");
		expect((await readFile(join(out, "runs.jsonl"), "utf8")).trim().split("\n")).toHaveLength(4);
	});

	it("bridge real sem --models falha antes de executar", async () => {
		await expect(main(["bridge"])).rejects.toThrow(/--models/);
	});

	it("bridge --estimate imprime a tabela sem chamar modelo", async () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (...items: unknown[]) => void lines.push(items.join(" "));
		try {
			expect(await main(["bridge", "--estimate", "--budget", "5"])).toBe(0);
		} finally {
			console.log = original;
		}
		expect(lines.join("\n")).toContain("Estimativa de custo");
		expect(lines.join("\n")).toContain("repeat 5, v2+v3");
	});
});
