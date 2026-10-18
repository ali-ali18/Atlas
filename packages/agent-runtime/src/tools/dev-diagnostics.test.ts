import { describe, expect, it } from "vitest";
import {
	createDiagnosticsScheduler,
	diagnosticsEnabledByEnv,
	formatDiagnosticsBlock,
	isDiagnosableFile,
	parseDetectOutput,
	parseTsDiagnostics,
	type Diagnostic,
	type TypecheckTarget,
} from "./dev-diagnostics.js";

const NL = String.fromCharCode(10);

function diag(file: string, line: number, extra: Partial<Diagnostic> = {}): Diagnostic {
	return { file: `/workspace/${file}`, line, col: 1, severity: "error", code: "TS2322", message: `erro ${file}:${line}`, ...extra };
}

describe("parseTsDiagnostics", () => {
	it("lê o formato do tsc, com prefixo de turbo, e ignora linhas de continuação e duplicatas", () => {
		const out = [
			"src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"  Type 'x' is not assignable to type 'y'.",
			"pkg:typecheck: src/b.tsx(3,9): warning TS6133: 'x' is declared but never used.",
			"src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"Found 2 errors.",
			"não é diagnóstico (1,2): error TS1: x.txt",
		].join(NL);
		const found = parseTsDiagnostics(out, "/workspace/packages/app");
		expect(found).toHaveLength(2);
		expect(found[0]).toEqual({ file: "/workspace/packages/app/src/a.ts", line: 12, col: 5, severity: "error", code: "TS2322", message: "Type 'string' is not assignable to type 'number'." });
		expect(found[1]).toMatchObject({ file: "/workspace/packages/app/src/b.tsx", severity: "warning", code: "TS6133" });
	});

	it("caminhos com .. e absolutos são normalizados", () => {
		const found = parseTsDiagnostics("../shared/x.ts(1,1): error TS1005: ';' expected." + NL + "/workspace/y.ts(2,2): error TS1005: ';' expected.", "/workspace/packages/app");
		expect(found.map((d) => d.file)).toEqual(["/workspace/packages/shared/x.ts", "/workspace/y.ts"]);
	});
});

describe("formatDiagnosticsBlock", () => {
	it("sem diagnósticos novos não injeta nada", () => {
		expect(formatDiagnosticsBlock([], new Set())).toBeNull();
		const reported = new Set<string>();
		expect(formatDiagnosticsBlock([diag("a.ts", 1)], reported)).not.toBeNull();
		expect(formatDiagnosticsBlock([diag("a.ts", 1)], reported)).toBeNull();
	});

	it("ordena por gravidade (erros antes de avisos) e põe os arquivos editados primeiro", () => {
		const all = [diag("z.ts", 1, { severity: "warning" }), diag("b.ts", 1), diag("a.ts", 2), diag("c.ts", 3, { severity: "warning" })];
		const text = formatDiagnosticsBlock(all, new Set(), new Set(["/workspace/b.ts"]))!;
		const lines = text.split(NL).slice(1);
		expect(lines[0]).toContain("b.ts:1:1 error");
		expect(lines[1]).toContain("a.ts:2:1 error");
		expect(lines[2]).toContain("c.ts:3:1 warning");
		expect(lines[3]).toContain("z.ts:1:1 warning");
		expect(text.startsWith("Diagnósticos após a edição")).toBe(true);
		expect(text).not.toContain("/workspace/");
	});

	it("no máximo 10 por arquivo e 30 no total, com contagem dos omitidos", () => {
		const one = Array.from({ length: 25 }, (_, i) => diag("a.ts", i + 1));
		const perFile = formatDiagnosticsBlock(one, new Set())!;
		expect(perFile.split(NL).filter((l) => l.startsWith("- ")).length).toBe(10);
		expect(perFile).toContain("(+15 omitidos)");

		const many = Array.from({ length: 8 }, (_, f) => Array.from({ length: 6 }, (_, i) => diag(`f${f}.ts`, i + 1))).flat();
		const total = formatDiagnosticsBlock(many, new Set())!;
		expect(total.split(NL).filter((l) => l.startsWith("- ")).length).toBe(30);
		expect(total).toContain("(+18 omitidos)");
	});

	it("o que ficou de fora aparece na vez seguinte e o já mostrado não repete (mesmo com a linha deslocada)", () => {
		const reported = new Set<string>();
		const all = Array.from({ length: 12 }, (_, i) => diag("a.ts", i + 1, { message: `m${i}` }));
		const first = formatDiagnosticsBlock(all, reported)!;
		expect(first.split(NL).filter((l) => l.startsWith("- ")).length).toBe(10);
		const shifted = all.map((d) => ({ ...d, line: d.line + 5 }));
		const second = formatDiagnosticsBlock(shifted, reported)!;
		expect(second.split(NL).filter((l) => l.startsWith("- ")).length).toBe(2);
		expect(formatDiagnosticsBlock(shifted, reported)).toBeNull();
	});
});

describe("agendador com debounce", () => {
	function harness(debounceMs = 20_000, settleMs = 1_500) {
		let clock = 0;
		const timers: Array<{ at: number; fn: () => void }> = [];
		const runs: Array<{ at: number; target: TypecheckTarget }> = [];
		const results: Diagnostic[][] = [];
		let release: (() => void) | undefined;
		let block = false;
		const scheduler = createDiagnosticsScheduler({
			now: () => clock,
			setTimer: (fn, ms) => {
				const timer = { at: clock + ms, fn };
				timers.push(timer);
				return timer;
			},
			debounceMs,
			settleMs,
			run: async (target) => {
				runs.push({ at: clock, target });
				if (block) await new Promise<void>((resolve) => (release = resolve));
				return [diag("a.ts", runs.length)];
			},
			onResult: (_target, diagnostics) => results.push(diagnostics),
		});
		/** Avança o relógio disparando os timers vencidos, em ordem. */
		async function advance(ms: number) {
			const end = clock + ms;
			for (;;) {
				const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				timers.splice(timers.indexOf(next), 1);
				clock = Math.max(clock, next.at);
				next.fn();
				if (block) await new Promise((resolve) => setTimeout(resolve, 0));
				else await scheduler.idle();
			}
			clock = end;
		}
		return { scheduler, advance, runs, results, setBlock: (v: boolean) => (block = v), release: () => release?.(), now: () => clock };
	}
	const pkgA: TypecheckTarget = { pkgDir: "/workspace/packages/a", cmd: "pnpm run typecheck" };
	const pkgB: TypecheckTarget = { pkgDir: "/workspace/packages/b", cmd: "pnpm run typecheck" };

	it("várias edições seguidas viram uma execução só, depois do tempo de junção", async () => {
		const h = harness();
		h.scheduler.schedule(pkgA);
		await h.advance(300);
		h.scheduler.schedule(pkgA);
		await h.advance(300);
		h.scheduler.schedule(pkgA);
		expect(h.runs).toHaveLength(0);
		await h.advance(1_500);
		expect(h.runs).toHaveLength(1);
		expect(h.results).toHaveLength(1);
	});

	it("no máximo uma execução por pacote a cada 20s; edições no intervalo entram na próxima", async () => {
		const h = harness();
		h.scheduler.schedule(pkgA);
		await h.advance(2_000);
		expect(h.runs).toHaveLength(1);
		const firstAt = h.runs[0]!.at;
		h.scheduler.schedule(pkgA);
		await h.advance(5_000);
		h.scheduler.schedule(pkgA);
		await h.advance(10_000);
		expect(h.runs).toHaveLength(1);
		await h.advance(10_000);
		expect(h.runs).toHaveLength(2);
		expect(h.runs[1]!.at - firstAt).toBeGreaterThanOrEqual(20_000);
		// Sem edição nova, nada roda de novo.
		await h.advance(60_000);
		expect(h.runs).toHaveLength(2);
	});

	it("pacotes diferentes têm limites independentes", async () => {
		const h = harness();
		h.scheduler.schedule(pkgA);
		h.scheduler.schedule(pkgB);
		await h.advance(2_000);
		expect(h.runs.map((r) => r.target.pkgDir).sort()).toEqual([pkgA.pkgDir, pkgB.pkgDir]);
	});

	it("edição durante a execução marca para rodar de novo, respeitando os 20s", async () => {
		const h = harness();
		h.setBlock(true);
		h.scheduler.schedule(pkgA);
		await h.advance(1_500);
		expect(h.runs).toHaveLength(1);
		h.scheduler.schedule(pkgA); // chega com o typecheck em andamento
		h.setBlock(false);
		h.release();
		await h.scheduler.idle();
		await h.advance(5_000);
		expect(h.runs).toHaveLength(1);
		await h.advance(20_000);
		expect(h.runs).toHaveLength(2);
	});
});

describe("detecção", () => {
	it("lê PKG e CMD; sem comando não há alvo", () => {
		expect(parseDetectOutput(["PKG=/workspace/packages/a/", "CMD=pnpm run typecheck"].join(NL))).toEqual({ pkgDir: "/workspace/packages/a", cmd: "pnpm run typecheck" });
		expect(parseDetectOutput("PKG=/workspace/a" + NL)).toBeNull();
		expect(parseDetectOutput("")).toBeNull();
	});
	it("só arquivos TS/JS contam (não .d.ts nem md)", () => {
		for (const ok of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.jsx", "a.mts"]) expect(isDiagnosableFile(`/workspace/${ok}`)).toBe(true);
		for (const no of ["a.d.ts", "a.md", "a.json", "a.css", "a.py"]) expect(isDiagnosableFile(`/workspace/${no}`)).toBe(false);
	});
	it("DEV_AFTER_EDIT_DIAGNOSTICS=off desliga; por padrão liga", () => {
		expect(diagnosticsEnabledByEnv({})).toBe(true);
		for (const off of ["off", "OFF", "0", "false", "no"]) expect(diagnosticsEnabledByEnv({ DEV_AFTER_EDIT_DIAGNOSTICS: off })).toBe(false);
		expect(diagnosticsEnabledByEnv({ DEV_AFTER_EDIT_DIAGNOSTICS: "on" })).toBe(true);
	});
});
