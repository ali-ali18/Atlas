import { describe, expect, it } from "vitest";
import { FACT_MAX_CHARS, applicableFacts, planLessonFacts, renderLessonFactsReport, type LessonFactInput } from "./lesson-facts.js";

const now = new Date("2026-11-04T12:00:00Z");
const recent = "2026-10-20T12:00:00Z";

function lesson(id: string, content: string, over: Partial<LessonFactInput> = {}): LessonFactInput {
	return { id, scope: "bot", scopeKey: null, content, helpful: 0, harmful: 0, uses: 1, createdAt: recent, updatedAt: recent, ...over };
}
const itemOf = (plan: ReturnType<typeof planLessonFacts>, id: string) => plan.items.find((item) => item.lessonId === id)!;

describe("planLessonFacts", () => {
	it("sem lições: plano vazio", () => {
		const plan = planLessonFacts({ lessons: [], now });
		expect(plan.items).toEqual([]);
		expect(plan.counts).toEqual({ total: 0, fact: 0, merge: 0, discard: 0, needsReview: 0 });
	});

	it("lição normal vira fato; conector leva o contexto na frente", () => {
		const plan = planLessonFacts({ lessons: [lesson("a", "Ao enviar relatório, use PDF"), lesson("b", "Filtre por data", { scope: "connector", scopeKey: "mcp:x1" })], now });
		expect(itemOf(plan, "a")).toMatchObject({ decision: "fact", reason: "ok", factText: "Ao enviar relatório, use PDF" });
		expect(itemOf(plan, "b").factText).toBe("(conector mcp:x1) Filtre por data");
	});

	it("vazia e só espaços são descartadas", () => {
		const plan = planLessonFacts({ lessons: [lesson("a", ""), lesson("b", "  \n ")], now });
		expect(plan.items.map((item) => item.reason)).toEqual(["empty", "empty"]);
	});

	it("texto com segredo é descartado e sai redigido no relatório", () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const plan = planLessonFacts({ lessons: [lesson("a", `Use o token ${secret} no git`)], now });
		const item = itemOf(plan, "a");
		expect(item).toMatchObject({ decision: "discard", reason: "secret", factText: "" });
		expect(item.original).not.toContain(secret);
		expect(renderLessonFactsReport([{ userId: "u", botId: "b", plan }], now)).not.toContain(secret);
	});

	it("texto muito longo não vira fato sozinho", () => {
		const plan = planLessonFacts({ lessons: [lesson("a", "x".repeat(FACT_MAX_CHARS + 1)), lesson("b", "y".repeat(FACT_MAX_CHARS))], now });
		expect(itemOf(plan, "a").reason).toBe("too_long");
		expect(itemOf(plan, "b").decision).toBe("fact");
	});

	it("duplicadas: a de melhor placar fica, a outra junta com ela", () => {
		const plan = planLessonFacts({
			lessons: [lesson("a", "Responda sempre em tópicos curtos", { helpful: 0 }), lesson("b", "responda sempre em tópicos curtos.", { helpful: 3 })],
			now,
		});
		expect(itemOf(plan, "b").decision).toBe("fact");
		expect(itemOf(plan, "a")).toMatchObject({ decision: "merge", reason: "duplicate", mergeIntoId: "b" });
	});

	it("já existe como fato na memória: descarta", () => {
		const plan = planLessonFacts({ lessons: [lesson("a", "O usuário prefere relatório curto")], existingFacts: ["O usuário prefere relatório curto."], now });
		expect(itemOf(plan, "a").reason).toBe("duplicate_of_fact");
	});

	it("obsoletas: mais nociva que útil e nunca usada há muito tempo", () => {
		const plan = planLessonFacts({
			lessons: [lesson("a", "Regra ruim de verdade", { harmful: 3 }), lesson("b", "Regra antiga parada", { uses: 0, updatedAt: "2025-01-01T00:00:00Z" }), lesson("c", "Regra antiga mas usada", { uses: 4, updatedAt: "2025-01-01T00:00:00Z" })],
			now,
		});
		expect(itemOf(plan, "a").reason).toBe("obsolete_harmful");
		expect(itemOf(plan, "b").reason).toBe("obsolete_stale");
		expect(itemOf(plan, "c").decision).toBe("fact");
	});

	it("conflito com placar diferente: a pior sai; a melhor pede revisão e não é aplicada", () => {
		const plan = planLessonFacts({
			lessons: [lesson("a", "Envie o resumo por e-mail ao terminar", { helpful: 2 }), lesson("b", "Não envie o resumo por e-mail ao terminar")],
			now,
		});
		expect(itemOf(plan, "b")).toMatchObject({ decision: "discard", reason: "conflict_loser", needsReview: true });
		expect(itemOf(plan, "a")).toMatchObject({ decision: "fact", needsReview: true, conflictWith: ["b"] });
		expect(applicableFacts(plan)).toEqual([]);
	});

	it("conflito empatado: as duas ficam para revisão", () => {
		const plan = planLessonFacts({ lessons: [lesson("a", "Use sempre tabela no relatório mensal"), lesson("b", "Nunca use tabela no relatório mensal")], now });
		expect(plan.items.every((item) => item.decision === "fact" && item.needsReview)).toBe(true);
		expect(plan.counts.needsReview).toBe(2);
	});

	it("assuntos diferentes com negação não conflitam", () => {
		const plan = planLessonFacts({ lessons: [lesson("a", "Nunca apague arquivos do cliente"), lesson("b", "Responda com saudação curta ao cumprimentar")], now });
		expect(plan.counts.needsReview).toBe(0);
		expect(applicableFacts(plan)).toHaveLength(2);
	});

	it("teto da memória: o que não cabe é descartado, o melhor entra primeiro", () => {
		const plan = planLessonFacts({
			lessons: [lesson("a", "Fato A bem curtinho aqui", { helpful: 5 }), lesson("b", "Fato B totalmente diferente agora")],
			budget: { limit: 30, used: 0 },
			now,
		});
		expect(itemOf(plan, "a").decision).toBe("fact");
		expect(itemOf(plan, "b").reason).toBe("over_budget");
	});

	it("é determinística: a ordem de entrada não muda as decisões", () => {
		const lessons = [lesson("a", "Fato um repetido igual"), lesson("b", "Fato um repetido igual"), lesson("c", "Outro assunto qualquer")];
		const first = planLessonFacts({ lessons, now });
		const second = planLessonFacts({ lessons: [...lessons].reverse(), now });
		const byId = (plan: typeof first) => Object.fromEntries(plan.items.map((item) => [item.lessonId, [item.decision, item.mergeIntoId ?? null]]));
		expect(byId(second)).toEqual(byId(first));
	});
});

describe("renderLessonFactsReport", () => {
	it("sem donos: avisa que não há lição", () => {
		expect(renderLessonFactsReport([], now)).toContain("Nenhuma lição ativa");
	});

	it("separa por dono e escapa quebra de linha e barra vertical", () => {
		const a = planLessonFacts({ lessons: [lesson("a", "Linha com | barra")], now });
		const b = planLessonFacts({ lessons: [lesson("b", "Segredo do outro dono")], now });
		const md = renderLessonFactsReport([{ userId: "u1", botId: "b1", plan: a }, { userId: "u2", botId: "b2", plan: b }], now);
		const [first, second] = md.split("## Dono u2");
		expect(first).toContain("Linha com \\| barra");
		expect(first).not.toContain("Segredo do outro dono");
		expect(second).toContain("Segredo do outro dono");
	});
});
