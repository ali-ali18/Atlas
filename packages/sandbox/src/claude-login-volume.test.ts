import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_LOGIN_MOUNT, claudeLoginBind, claudeLoginVolumeName } from "./claude-login-volume.js";
import { homeVolumeName, profileVolumeName, workVolumeName } from "./docker-manager.js";

describe("volume do login do Claude Code", () => {
	it("é estável por bot e dono, e tem prefixo próprio", () => {
		const name = claudeLoginVolumeName("bot-1", "user-a");
		expect(name).toBe(claudeLoginVolumeName("bot-1", "user-a"));
		expect(name).toMatch(/^atlas-claude-[0-9a-f]{64}$/);
	});

	it("outro bot ou outro dono cai em outro volume (escopo por dono)", () => {
		const a = claudeLoginVolumeName("bot-1", "user-a");
		expect(claudeLoginVolumeName("bot-2", "user-a")).not.toBe(a);
		expect(claudeLoginVolumeName("bot-1", "user-b")).not.toBe(a);
		// trocar os campos de lugar não colide
		expect(claudeLoginVolumeName("user-a", "bot-1")).not.toBe(a);
	});

	it("não colide com home, perfil e work do mesmo bot", () => {
		const others = [homeVolumeName("bot-1", "user-a"), profileVolumeName("bot-1", "user-a"), workVolumeName("bot-1", "user-a")];
		expect(others).not.toContain(claudeLoginVolumeName("bot-1", "user-a"));
	});

	it("recusa id vazio em vez de gerar um volume compartilhado", () => {
		expect(() => claudeLoginVolumeName("", "user-a")).toThrow();
		expect(() => claudeLoginVolumeName("bot-1", "")).toThrow();
	});

	it("monta em ~/.claude, leitura e escrita", () => {
		expect(CLAUDE_LOGIN_MOUNT).toBe("/home/atlas/.claude");
		expect(claudeLoginBind("bot-1", "user-a")).toBe(`${claudeLoginVolumeName("bot-1", "user-a")}:/home/atlas/.claude`);
	});
});

// ADR 0006: o Atlas nunca lê o login do Claude Code. Guarda estática: fora do módulo que monta o volume,
// nenhum código-fonte (não-teste) cita os arquivos de credencial nem o volume/caminho de login.
describe("nenhum código do Atlas lê o login do Claude Code", () => {
	const repoRoot = new URL("../../../", import.meta.url).pathname;
	const allowed = new Set(["packages/sandbox/src/claude-login-volume.ts", "packages/sandbox/src/index.ts"]);
	const forbidden = /\.credentials\.json|\.claude\.json|\.claude\/|CLAUDE_LOGIN_MOUNT|claudeLoginVolumeName|claudeLoginBind|atlas-claude-/;

	function sources(dir: string, out: string[] = []): string[] {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".turbo") continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) sources(full, out);
			else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.test\./.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
		}
		return out;
	}

	it("só o módulo do volume (e o índice que o reexporta) cita credencial ou o volume", () => {
		const roots = ["packages", "apps"].flatMap((top) =>
			readdirSync(join(repoRoot, top)).map((name) => join(repoRoot, top, name, "src")),
		);
		const extra = [join(repoRoot, "docker/agent-sandbox/control"), join(repoRoot, "docker/dev-sandbox/server")];
		const offenders: string[] = [];
		for (const root of [...roots, ...extra]) {
			try {
				statSync(root);
			} catch {
				continue;
			}
			for (const file of sources(root)) {
				const rel = relative(repoRoot, file);
				if (!allowed.has(rel) && forbidden.test(readFileSync(file, "utf8"))) offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
