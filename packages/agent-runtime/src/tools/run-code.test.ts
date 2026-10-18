import { CodeRunnerUnavailableError, type CodeRunInput, type CodeRunResult } from "@workspace/sandbox";
import { describe, expect, it, vi } from "vitest";
import { RUN_CODE_TOOL, executeRunCode, parseRunCodeArgs, type FileEvent, type RunCodeContext, type RunCodeDeps } from "./run-code.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const bytes = (text: string) => new TextEncoder().encode(text);

function result(overrides: Partial<CodeRunResult> = {}): CodeRunResult {
	return { exitCode: 0, timedOut: false, stdout: "42\n", stderr: "", truncated: false, durationMs: 1500, outputs: [], omitted: [], inputNames: [], crashed: false, ...overrides };
}

function setup(run: Partial<CodeRunResult> | Error = {}, ctxOverrides: Partial<RunCodeContext> = {}) {
	const runSpy = vi.fn(async (_input: CodeRunInput) => {
		if (run instanceof Error) throw run;
		return result(run);
	});
	const persisted: Array<{ kind: string; mime: string; meta?: Record<string, unknown> }> = [];
	const files: FileEvent[] = [];
	const images: unknown[] = [];
	let shown = 0;
	const deps: Partial<RunCodeDeps> = {
		run: runSpy,
		loadArtifact: vi.fn(async (id: string) => (id === "art1"
			? ({ id, kind: "file", meta: { mime: "text/csv", filename: "vendas.csv", ext: "csv" }, runId: null, conversationId: "c1", createdAt: new Date(), bytes: Buffer.from("a,b") })
			: id === "foreign"
				? ({ id, kind: "file", meta: { mime: "text/csv", filename: "x.csv" }, runId: null, conversationId: "other", createdAt: new Date(), bytes: Buffer.from("x") })
				: null) as never),
		persist: vi.fn(async (input) => {
			persisted.push({ kind: input.kind, mime: input.mime, meta: input.meta });
			return { id: `art-${persisted.length}`, kind: input.kind, meta: { ...(input.meta ?? {}), mime: input.mime }, runId: null, conversationId: null, createdAt: new Date() };
		}),
		nextVersion: vi.fn(async () => 1),
		countRunFiles: vi.fn(async () => 0),
		processImage: vi.fn(async () => ({ bytes: Buffer.from("png"), mime: "image/png" as const, width: 800, height: 600 })),
	};
	const ctx: RunCodeContext = {
		userId: "u1", runId: "r1", conversationId: "c1",
		attachments: { list: async () => [{ id: "att1", filename: "Planilha 2024.xlsx" }], bytes: async (id) => (id === "att1" ? bytes("xlsx-bytes") : null) },
		showImages: { remaining: () => 6 - shown, add: (n) => { shown += n; }, emit: async (event) => { images.push(event); } },
		emitFile: async (event) => { files.push(event); },
		...ctxOverrides,
	};
	return { deps, ctx, runSpy, persisted, files, images };
}

describe("run_code: definição e validação", () => {
	it("a descrição orienta contas/planilhas/gráficos e proíbe navegação e desenvolvimento", () => {
		const description = RUN_CODE_TOOL.function.description ?? "";
		expect(description).toMatch(/WITHOUT starting the VM/);
		expect(description).toMatch(/no internet/);
		expect(description).toMatch(/\/work\/out/);
		expect(description).toMatch(/Do NOT use it for browsing/);
		expect(RUN_CODE_TOOL.function.name).toBe("run_code");
	});

	it("exige code, limita arquivos e normaliza prefixos de id e timeout", () => {
		expect(() => parseRunCodeArgs({})).toThrow(/code is required/);
		expect(() => parseRunCodeArgs({ code: "  " })).toThrow(/code is required/);
		expect(() => parseRunCodeArgs({ code: "x", files: "a" })).toThrow(/array/);
		expect(() => parseRunCodeArgs({ code: "x", files: [1] })).toThrow(/array/);
		expect(() => parseRunCodeArgs({ code: "x", files: Array.from({ length: 11 }, (_, i) => `f${i}`) })).toThrow(/Too many/);
		expect(() => parseRunCodeArgs({ code: "x", timeoutSec: 0 })).toThrow(/timeoutSec/);
		expect(parseRunCodeArgs({ code: "x", files: ["attachment:a", "artifact:b", "a"], timeoutSec: 999 })).toEqual({ code: "x", files: ["a", "b"], timeoutSec: 120 });
	});

	it("sem usuário logado falha antes de executar", async () => {
		const { deps, ctx, runSpy } = setup({}, { userId: undefined });
		await expect(executeRunCode({ code: "print(1)" }, ctx, deps)).rejects.toThrow(/signed-in user/);
		expect(runSpy).not.toHaveBeenCalled();
	});
});

describe("run_code: arquivos de entrada", () => {
	it("mapeia anexos e arquivos da conversa para nomes de entrada", async () => {
		const { deps, ctx, runSpy } = setup({ inputNames: ["Planilha 2024.xlsx", "vendas.csv"] });
		const { summary } = await executeRunCode({ code: "print(1)", files: ["att1", "art1"] }, ctx, deps);
		const input = runSpy.mock.calls[0]![0];
		expect(input.files!.map((file) => file.name)).toEqual(["Planilha 2024.xlsx", "vendas.csv"]);
		expect(new TextDecoder().decode(input.files![0]!.bytes)).toBe("xlsx-bytes");
		expect(input.labels).toEqual({ "atlas.run": "r1" });
		expect(summary).toContain("in/Planilha 2024.xlsx");
	});

	it("id desconhecido ou de outra conversa vira erro acionável sem executar", async () => {
		const { deps, ctx, runSpy } = setup();
		await expect(executeRunCode({ code: "x", files: ["nada"] }, ctx, deps)).rejects.toThrow(/not found in this conversation/);
		await expect(executeRunCode({ code: "x", files: ["foreign"] }, ctx, deps)).rejects.toThrow(/not found in this conversation/);
		expect(runSpy).not.toHaveBeenCalled();
	});
});

describe("run_code: resultado e saídas", () => {
	it("devolve stdout e status; erro de execução pede correção", async () => {
		const ok = setup({ stdout: "total=10\n" });
		expect((await executeRunCode({ code: "x" }, ok.ctx, ok.deps)).summary).toMatch(/Exit code 0[\s\S]*stdout:\ntotal=10/);
		const bad = setup({ exitCode: 1, stdout: "", stderr: "Traceback...\nNameError: x" });
		const { summary } = await executeRunCode({ code: "x" }, bad.ctx, bad.deps);
		expect(summary).toMatch(/Exit code 1/);
		expect(summary).toMatch(/fix the script/);
		expect(summary).toContain("NameError");
	});

	it("avisa timeout e falta de memória", async () => {
		const t = setup({ exitCode: null, timedOut: true });
		expect((await executeRunCode({ code: "x" }, t.ctx, t.deps)).summary).toMatch(/TIMED OUT/);
		const m = setup({ exitCode: null, crashed: true });
		expect((await executeRunCode({ code: "x" }, m.ctx, m.deps)).summary).toMatch(/out of memory/);
	});

	it("imagens viram artefato de imagem mostrado no chat; demais viram cartões de arquivo", async () => {
		const { deps, ctx, persisted, files, images } = setup({
			outputs: [{ name: "grafico.png", bytes: PNG }, { name: "resumo.xlsx", bytes: bytes("xlsx") }, { name: "dados.csv", bytes: bytes("a,b") }],
		});
		const { summary, fileEvents } = await executeRunCode({ code: "x" }, ctx, deps);
		expect(persisted.map((item) => item.kind)).toEqual(["image", "file", "file"]);
		expect(images).toHaveLength(1);
		expect((images[0] as { items: Array<{ alt?: string }> }).items[0]!.alt).toBe("grafico.png");
		expect(files.map((file) => [file.filename, file.format])).toEqual([["resumo.xlsx", "xlsx"], ["dados.csv", "text"]]);
		expect(fileEvents).toHaveLength(2);
		expect(files[0]!.mime).toMatch(/spreadsheetml/);
		expect(files[0]!.runId).toBe("r1");
		expect(summary).toMatch(/Delivered to the user/);
		expect(summary).toContain("grafico.png");
	});

	it("com visão: devolve até 2 imagens geradas para o modelo ver; sem visão, nenhuma", async () => {
		const outputs = [1, 2, 3].map((n) => ({ name: `g${n}.png`, bytes: PNG }));
		const seeing = setup({ outputs }, { canSeeImages: true });
		const withVision = await executeRunCode({ code: "x" }, seeing.ctx, seeing.deps);
		expect(withVision.visionArtifactIds).toEqual(["art-1", "art-2"]);
		expect(withVision.summary).toMatch(/attached to the next message/);
		const blind = setup({ outputs }, { canSeeImages: false });
		const without = await executeRunCode({ code: "x" }, blind.ctx, blind.deps);
		expect(without.visionArtifactIds).toEqual([]);
		expect(without.summary).not.toMatch(/attached to the next message/);
	});

	it("tipos bloqueados e excesso de arquivos por run entram em 'Not delivered'", async () => {
		const { deps, ctx, files } = setup({ omitted: ["extra.bin (limite de 10 arquivos)"], outputs: [{ name: "malware.exe", bytes: bytes("MZ") }, { name: "ok.csv", bytes: bytes("a") }] });
		deps.countRunFiles = vi.fn(async () => 5);
		const { summary } = await executeRunCode({ code: "x" }, ctx, deps);
		expect(files).toHaveLength(0);
		expect(summary).toMatch(/Not delivered:.*extra\.bin.*malware\.exe.*ok\.csv/);
	});

	it("sem nada em /work/out avisa o modelo", async () => {
		const { deps, ctx } = setup({ stdout: "" });
		expect((await executeRunCode({ code: "x" }, ctx, deps)).summary).toMatch(/No file was saved in \/work\/out/);
	});
});

describe("run_code: executor indisponível", () => {
	it("imagem ausente chega ao modelo como 'o executor de código não está instalado'", async () => {
		const { deps, ctx } = setup(new CodeRunnerUnavailableError("O executor de código não está instalado neste servidor (imagem x ausente)."));
		await expect(executeRunCode({ code: "x" }, ctx, deps)).rejects.toThrow(/o executor de código não está instalado/i);
	});
});

describe("run_code: gráficos nativos (*.chart.json)", () => {
	const spec = (extra: Record<string, unknown> = {}) =>
		bytes(JSON.stringify({ type: "bar", title: "Vendas", x: "loja", series: [{ key: "total" }], data: [{ loja: "Centro", total: 10 }, { loja: "Norte", total: 7 }], ...extra }));

	it("vira evento de gráfico (não arquivo) e o resumo descreve o spec sem repetir os pontos", async () => {
		const charts: unknown[] = [];
		const { deps, ctx, persisted, files } = setup({ outputs: [{ name: "vendas.chart.json", bytes: spec() }] }, { callId: "call-9", emitChart: async (event) => { charts.push(event); } });
		const { summary, chartEvents } = await executeRunCode({ code: "x" }, ctx, deps);
		expect(persisted).toHaveLength(0);
		expect(files).toHaveLength(0);
		expect(charts).toEqual(chartEvents);
		expect(chartEvents[0]).toMatchObject({ type: "chart", chartId: "call-9:vendas.chart.json", filename: "vendas.chart.json", runId: "r1", spec: { type: "bar", xKind: "category" } });
		expect(summary).toContain('Interactive chart shown to the user');
		expect(summary).toContain('vendas.chart.json: bar chart "Vendas", 2 points');
		expect(summary).not.toMatch(/No file was saved/);
	});

	it("spec inválido não vira gráfico nem arquivo: o motivo volta ao modelo", async () => {
		const { deps, ctx, files } = setup({ outputs: [{ name: "ruim.chart.json", bytes: bytes('{"type":"radar"}') }, { name: "quebrado.chart.json", bytes: bytes("{") }] });
		const { summary, chartEvents } = await executeRunCode({ code: "x" }, ctx, deps);
		expect(chartEvents).toHaveLength(0);
		expect(files).toHaveLength(0);
		expect(summary).toMatch(/Not delivered:.*ruim\.chart\.json \(invalid chart spec: type must be one of.*quebrado\.chart\.json \(invalid chart spec: chart spec is not valid JSON\)/);
	});

	it("limita os gráficos por chamada e continua entregando arquivos comuns", async () => {
		const outputs = [1, 2, 3, 4, 5].map((n) => ({ name: `g${n}.chart.json`, bytes: spec() }));
		const { deps, ctx, files } = setup({ outputs: [...outputs, { name: "dados.csv", bytes: bytes("a,b") }] });
		const { chartEvents, summary } = await executeRunCode({ code: "x" }, ctx, deps);
		expect(chartEvents).toHaveLength(4);
		expect(files.map((file) => file.filename)).toEqual(["dados.csv"]);
		expect(summary).toMatch(/g5\.chart\.json \(limit of 4 charts per call\)/);
	});

	it("a descrição da ferramenta prefere o spec ao PNG do matplotlib", () => {
		const description = RUN_CODE_TOOL.function.description ?? "";
		expect(description).toMatch(/PREFER a native chart spec/);
		expect(description).toMatch(/\.chart\.json/);
		expect(description).toMatch(/only for charts the spec cannot express/);
	});
});

describe("run_code: resumo do cartão gravado", () => {
	it("junta stdout e stderr, marca falha e traz tempo", async () => {
		const bad = setup({ exitCode: 1, stdout: "parcial\n", stderr: "NameError: x", durationMs: 2300 });
		const { codeRun } = await executeRunCode({ code: "x" }, bad.ctx, bad.deps);
		expect(codeRun).toEqual({ ok: false, durationMs: 2300, output: "parcial\n— stderr —\nNameError: x" });
		const ok = setup({ stdout: "42\n" });
		expect((await executeRunCode({ code: "x" }, ok.ctx, ok.deps)).codeRun).toEqual({ ok: true, durationMs: 1500, output: "42" });
		const timeout = setup({ exitCode: null, timedOut: true, stdout: "" });
		expect((await executeRunCode({ code: "x" }, timeout.ctx, timeout.deps)).codeRun).toMatchObject({ ok: false, output: "Tempo esgotado." });
	});
});
