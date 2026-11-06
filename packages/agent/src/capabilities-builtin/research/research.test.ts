import { describe, expect, it } from "vitest";
import { WORK_NOTE_PREFIX } from "../../kernel/work-notes.js";
import type { HelperResult } from "../../ports/helpers.js";
import { FakeHelpers } from "../../presets/fakes.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import { createExecutor } from "../../contract/executor.js";
import { chatPolicy } from "../../testing/contract-helpers.js";
import { sha256 } from "../../testing/fake-ports.js";
import { createResearchCapability, INLINE_RESULT_CHARS, MAX_RESEARCH_QUESTIONS, RESEARCH_INSTRUCTIONS } from "./index.js";
import { createResearchTool } from "./research.js";
import { defineCapability } from "../../capabilities/define-capability.js";
import { createNoteReadTool, DEFAULT_PAGE_CHARS } from "../../kernel/work-notes.js";

const done = (text: string, urls: string[] = ["https://a.test/x"], untrustedRead = true): HelperResult => ({ status: "done", text, sources: urls.map((url) => ({ url })), spentUsd: 0.01, untrustedRead });
const plan = (...questions: string[]) => ({ questions: questions.map((question) => ({ question })), output_format: "answer" });

function ctxFor(h: ReturnType<typeof kernelHarness>) {
	return { runId: "run-1", ownerId: "owner-1", ports: h.ports };
}

describe("tool research", () => {
	it("roda os ajudantes em paralelo, na ordem do plano, e devolve resposta + fontes por sub-pergunta", async () => {
		const helpers = new FakeHelpers((task) => done(`R:${task.objective}`, [`https://s.test/${task.objective}`]));
		const h = kernelHarness([]);
		const result = await createResearchTool(helpers).run({ questions: [{ question: "A" }, { question: "B" }, { question: "C", capabilities: ["web"] }], output_format: "table", context: "meta" }, ctxFor(h));
		expect(result.ok).toBe(true);
		const text = result.ok ? result.summary : "";
		expect(helpers.calls).toHaveLength(1);
		expect(helpers.maxConcurrent).toBe(3);
		expect(helpers.calls[0]?.tasks.map((t) => [t.objective, t.capabilities, t.context])).toEqual([["A", ["web"], "meta"], ["B", ["web"], "meta"], ["C", ["web"], "meta"]]);
		expect(text.indexOf("R:A")).toBeLessThan(text.indexOf("R:B"));
		expect(text.indexOf("R:B")).toBeLessThan(text.indexOf("R:C"));
		expect(text).toContain("https://s.test/B");
		expect(text).toContain("table");
	});

	it("grava no caderno do run (inteiro, com a fonte por afirmação) e só o dono do run lê", async () => {
		const h = kernelHarness([]);
		await createResearchTool(new FakeHelpers((t) => done(`achado ${t.objective}`, ["https://f.test/1", "https://f.test/1", "https://f.test/2"]))).run(plan("P1", "P2"), ctxFor(h));
		const note = await h.notes.get("owner-1", `${WORK_NOTE_PREFIX}run-1:research:1`);
		expect(note?.body).toContain("achado P1");
		expect(note?.body).toContain("https://f.test/2");
		expect(note?.body.match(/https:\/\/f\.test\/1/g)).toHaveLength(2); // dedupe por sub-pergunta: 1 vez em P1 e 1 em P2
		expect(await h.notes.get("owner-2", `${WORK_NOTE_PREFIX}run-1:research:1`)).toBeNull();
	});

	it("chamadas seguidas no mesmo run gravam notas distintas", async () => {
		const h = kernelHarness([]);
		const tool = createResearchTool(new FakeHelpers());
		await tool.run(plan("A"), ctxFor(h));
		await tool.run(plan("B"), ctxFor(h));
		expect((await h.notes.list("owner-1")).map((n) => n.id).sort()).toEqual([`${WORK_NOTE_PREFIX}run-1:research:1`, `${WORK_NOTE_PREFIX}run-1:research:2`]);
	});

	it("retomada: duas instâncias da tool (a tool é recriada) não sobrescrevem a nota da pesquisa anterior (auditoria F3, C2/B1)", async () => {
		const h = kernelHarness([]);
		const first = await createResearchTool(new FakeHelpers(() => done("achado UM"))).run(plan("P1"), { ...ctxFor(h), callId: "s1:call-a" });
		const second = await createResearchTool(new FakeHelpers(() => done("achado DOIS"))).run(plan("P2"), { ...ctxFor(h), callId: "s2:call-b" });
		const ids = (await h.notes.list("owner-1")).map((n) => n.id).sort();
		expect(ids).toEqual([`${WORK_NOTE_PREFIX}run-1:research:s1:call-a`, `${WORK_NOTE_PREFIX}run-1:research:s2:call-b`]);
		expect((await h.notes.get("owner-1", ids[0] as string))?.body).toContain("achado UM");
		expect(first.ok && first.summary).toContain("research:s1:call-a");
		expect(second.ok && second.summary).toContain("research:s2:call-b");
	});

	it("sem callId, ou a mesma chamada reexecutada: pega o próximo id livre, nunca sobrescreve", async () => {
		const h = kernelHarness([]);
		await createResearchTool(new FakeHelpers(() => done("achado UM"))).run(plan("P1"), ctxFor(h));
		await createResearchTool(new FakeHelpers(() => done("achado DOIS"))).run(plan("P2"), ctxFor(h));
		await createResearchTool(new FakeHelpers(() => done("achado A"))).run(plan("P3"), { ...ctxFor(h), callId: "s1:x" });
		await createResearchTool(new FakeHelpers(() => done("achado B"))).run(plan("P3"), { ...ctxFor(h), callId: "s1:x" });
		const notes = await h.notes.list("owner-1");
		expect(notes).toHaveLength(4);
		expect((await h.notes.get("owner-1", `${WORK_NOTE_PREFIX}run-1:research:1`))?.body).toContain("achado UM");
		expect((await h.notes.get("owner-1", `${WORK_NOTE_PREFIX}run-1:research:s1:x`))?.body).toContain("achado A");
	});

	it("resposta parcial do ajudante aparece como \"not confirmed\" com o motivo, na resposta inline e no índice (auditoria F3, B2)", async () => {
		const partial = (text: string): HelperResult => ({ ...done(text), partial: true, error: "partial answer: the last tool call(s) failed (web_extract: timeout)" });
		const h = kernelHarness([]);
		const inline = await createResearchTool(new FakeHelpers((t) => (t.objective === "B" ? partial("so metade") : done("inteiro")))).run(plan("A", "B"), ctxFor(h));
		const text = inline.ok ? inline.summary : "";
		expect(text).toContain("1 answer(s) are partial");
		expect(text).toContain("NOT CONFIRMED (partial answer): partial answer: the last tool call(s) failed (web_extract: timeout)");
		expect(text).toContain("### 2. B\nNOT CONFIRMED (partial answer)");
		expect(text).toContain("### 1. A\ninteiro");
		const big = await createResearchTool(new FakeHelpers(() => partial("x".repeat(INLINE_RESULT_CHARS)))).run(plan("A"), { ...ctxFor(h), callId: "s9:big" });
		expect(big.ok && big.summary).toContain("NOT CONFIRMED (partial answer), 1 source(s)");
	});

	it("falha parcial: diz qual ajudante falhou e o motivo real; os outros seguem", async () => {
		const helpers = new FakeHelpers((task, index) => (index === 1 ? { status: "failed", text: "", sources: [], spentUsd: 0, untrustedRead: false, error: "timeout ao ler a página" } : done(`ok ${task.objective}`)));
		const h = kernelHarness([]);
		const result = await createResearchTool(helpers).run(plan("A", "B", "C"), ctxFor(h));
		expect(result.ok).toBe(true);
		const text = result.ok ? result.summary : "";
		expect(text).toContain("1 of 3 helper(s) failed");
		expect(text).toContain("HELPER FAILED: timeout ao ler a página");
		expect(text).toContain("ok A");
		expect(text).toContain("ok C");
	});

	it("todos falharam: ok:false com os motivos (sem sucesso falso)", async () => {
		const helpers = new FakeHelpers(() => ({ status: "stopped", text: "", sources: [], spentUsd: 0, untrustedRead: false, error: "cancelado" }));
		const result = await createResearchTool(helpers).run(plan("A", "B"), ctxFor(kernelHarness([])));
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("cancelado");
	});

	it("a porta lançar erro vira ok:false com a mensagem real", async () => {
		const helpers = { runAll: async () => Promise.reject(new Error("fila indisponível")) };
		const result = await createResearchTool(helpers).run(plan("A"), ctxFor(kernelHarness([])));
		expect(!result.ok && result.error).toContain("fila indisponível");
	});

	it("resposta sem fonte não é apresentada como confirmada", async () => {
		const result = await createResearchTool(new FakeHelpers(() => done("sem fonte", []))).run(plan("A"), ctxFor(kernelHarness([])));
		expect(result.ok && result.summary).toContain("Do not present this answer as confirmed");
	});

	it("resultado grande: índice com ponteiro note_read por sub-pergunta, sem cortar; a nota tem tudo", async () => {
		const big = "x".repeat(INLINE_RESULT_CHARS);
		const h = kernelHarness([]);
		const result = await createResearchTool(new FakeHelpers((t) => done(`${t.objective}:${big}`))).run(plan("Q1", "Q2"), ctxFor(h));
		const text = result.ok ? result.summary : "";
		expect(text.length).toBeLessThan(INLINE_RESULT_CHARS);
		const id = `${WORK_NOTE_PREFIX}run-1:research:1`;
		const offsets = [...text.matchAll(/offset=(\d+)\)/g)].map((m) => Number(m[1]));
		expect(offsets).toHaveLength(2);
		const note = await h.notes.get("owner-1", id);
		expect(note?.body.slice(offsets[1])).toContain(`Q2:${big}`);
		// o modelo lê pelo note_read, que é o ponteiro honesto
		const read = await createNoteReadTool(DEFAULT_PAGE_CHARS).run({ id, offset: offsets[0] }, ctxFor(h));
		expect(read.ok && read.summary).toContain("### 1. Q1");
	});

	describe("validação dos args", () => {
		const run = (args: unknown) => createResearchTool(new FakeHelpers()).run(args, ctxFor(kernelHarness([])));
		it("plano vazio", async () => {
			const r = await run({ questions: [], output_format: "answer" });
			expect(!r.ok && r.error).toContain("at least one sub-question");
		});
		it("sub-pergunta vazia", async () => {
			const r = await run({ questions: [{ question: "  " }], output_format: "answer" });
			expect(!r.ok && r.error).toContain("must not be empty");
		});
		it("capacidade desconhecida lista as aceitas", async () => {
			const r = await run({ questions: [{ question: "A", capabilities: ["shell"] }], output_format: "answer" });
			expect(!r.ok && r.error).toMatch(/web/);
		});
		it("formato fora do enum lista os aceitos", async () => {
			const r = await run({ questions: [{ question: "A" }], output_format: "pdf" });
			expect(!r.ok && r.error).toMatch(/answer.*table.*document/);
		});
		it("campo desconhecido e plano grande demais", async () => {
			expect((await run({ questions: [{ question: "A" }], output_format: "answer", depth: 3 })).ok).toBe(false);
			const many = Array.from({ length: MAX_RESEARCH_QUESTIONS + 1 }, (_, i) => ({ question: `q${i}` }));
			expect((await run({ questions: many, output_format: "answer" })).ok).toBe(false);
		});
		it("nenhum ajudante roda com args inválidos", async () => {
			const helpers = new FakeHelpers();
			await createResearchTool(helpers).run({ questions: [], output_format: "answer" }, ctxFor(kernelHarness([])));
			expect(helpers.calls).toHaveLength(0);
		});
	});
});

describe("research: taint (cláusula 8)", () => {
	it("a tool é declarada não confiável (web): o executor marca o run, mesmo que o ajudante tenha lido pouco", async () => {
		const tool = createResearchTool(new FakeHelpers(() => done("texto da web", [], true)));
		expect(tool.trust).toBe("untrusted");
		expect(tool.source).toBe("web");
		const h = kernelHarness([]);
		const executor = createExecutor({ runId: "run-1", ownerId: "owner-1", ports: h.ports, hash: sha256, policy: { ...chatPolicy, autonomy: "autonomous" } });
		expect(executor.provenance.untrustedReadInRun).toBe(false);
		const out = await executor.executeCall({ callId: "c1", step: 1, tool, args: plan("A") });
		expect(out.status).toBe("ok");
		expect(executor.provenance.untrustedReadInRun).toBe(true);
	});
});

describe("capacidade research", () => {
	it("é lazy, tem as instruções e a tool só aparece depois do use_capability", async () => {
		const capability = createResearchCapability(new FakeHelpers());
		expect(capability.core).toBe(false);
		expect(capability.tools.map((t) => t.name)).toEqual(["research"]);
		const core = defineCapability({ id: "core", title: "Core", summary: "core tools", core: true, tools: [] });
		const h = kernelHarness([reply({ calls: [call("c1", "use_capability", { id: "research" })] }), reply({ calls: [call("c2", "research", plan("A", "B"))] }), reply({ text: "Pronto." })], { capabilities: [core, capability] });
		const result = await h.run({ input: { contextSections: [], history: [{ kind: "owner", text: "compare 10 fornecedores" }] } });
		expect(result.status).toBe("done");
		const [first, second, third] = h.llm.requests;
		expect((first?.tools ?? []).map((t) => t.name)).not.toContain("research");
		expect((second?.tools ?? []).map((t) => t.name)).toContain("research");
		expect(JSON.stringify(second?.messages)).toContain("One source per claim");
		expect(JSON.stringify(third?.messages)).toContain("Resposta: A");
		expect((await h.notes.list("owner-1")).some((n) => n.id.startsWith(`${WORK_NOTE_PREFIX}run-1:research`))).toBe(true);
	});

	it("instruções: proporcional, divergência, uma fonte por afirmação, formato, sem parar por custo, sem nomes internos para o dono", () => {
		for (const piece of ["single direct web search", "disagree", "One source per claim", "table", "create_file", "Do not stop researching to save cost", "do not mention tool or field names"]) expect(RESEARCH_INSTRUCTIONS).toContain(piece);
		expect(RESEARCH_INSTRUCTIONS).toContain("cite both");
	});

});
