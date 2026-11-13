import { describe, expect, it } from "vitest";
import { buildDayPlanSections, parseConversationCard, parseDayPlanCard, serializeConversationCard } from "./index.js";

describe("buildDayPlanSections", () => {
	it("monta as seções na ordem fixa e seção vazia some (nunca 'nada por enquanto')", () => {
		const r = buildDayPlanSections({
			headline: "  Hoje: 2 compromissos e 1 e-mail pede resposta.  ",
			deliveries: [{ text: "Fone X chega hoje" }],
			commitments: [{ text: "Reunião com o time", time: "09:00" }, { text: "Dentista", time: "15:00", detail: "Leve o convênio" }],
			emails: [{ text: "Contador pede o recibo", detail: "prazo sexta" }],
			pending: [],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.headline).toBe("Hoje: 2 compromissos e 1 e-mail pede resposta.");
		expect(r.sections.map((s) => s.id)).toEqual(["commitments", "emails", "deliveries"]);
		expect(r.sections[0]!.items[1]).toEqual({ text: "Dentista", time: "15:00", detail: "Leve o convênio" });
	});
	it("só o dia livre é válido: sem seção nenhuma, com a frase", () => {
		expect(buildDayPlanSections({ headline: "Dia livre." })).toEqual({ ok: true, headline: "Dia livre.", sections: [] });
	});
	it("recusa: sem frase, item sem texto, seção grande demais (o limite vem na mensagem), forma errada", () => {
		expect(buildDayPlanSections({ headline: " " })).toMatchObject({ ok: false, error: expect.stringContaining("headline") });
		expect(buildDayPlanSections({ headline: "x", pending: [{ text: " " }] })).toMatchObject({ ok: false, error: expect.stringContaining("pending") });
		expect(buildDayPlanSections({ headline: "x", emails: Array.from({ length: 9 }, (_, i) => ({ text: `e${i}` })) })).toMatchObject({ ok: false, error: expect.stringContaining("limit is 8") });
		expect(buildDayPlanSections({ headline: "x", commitments: "reunião" })).toMatchObject({ ok: false });
	});
	it("hora só em compromisso; quebras de linha viram espaço", () => {
		const r = buildDayPlanSections({ headline: "x", emails: [{ text: "a\nb", time: "09:00" }] });
		expect(r.ok && r.sections[0]!.items[0]).toEqual({ text: "a b" });
	});
});

describe("cartão day-plan persistido", () => {
	const card = { v: 1, kind: "day-plan", planId: "day-plan:run-1", runId: "run-1", date: "2026-11-10", timeZone: "America/Sao_Paulo", headline: "Hoje: 1 compromisso.", sections: [{ id: "commitments", items: [{ text: "Reunião", time: "09:00" }] }], sourceErrors: [{ source: "calendar", reason: "failed" }] };
	it("vai e volta, com a fonte em falha como dado (a UI escreve a linha)", () => {
		expect(parseConversationCard(serializeConversationCard(card as never))).toEqual(card);
	});
	it("recusa lixo e descarta o que não é válido: fuso falso, seção desconhecida, fonte desconhecida, seção repetida", () => {
		expect(parseDayPlanCard({ ...card, timeZone: "Marte" })).toBeNull();
		expect(parseDayPlanCard({ ...card, sections: [{ id: "segredos", items: [] }] })).toBeNull();
		expect(parseDayPlanCard({ ...card, date: "hoje" })).toBeNull();
		const odd = parseDayPlanCard({ ...card, sourceErrors: [{ source: "calendar", reason: "failed" }, { source: "calendar", reason: "needs_connection" }, { source: "outra", reason: "failed" }], sections: [card.sections[0], card.sections[0]] });
		expect(odd?.sourceErrors).toEqual([{ source: "calendar", reason: "failed" }]);
		expect(odd?.sections).toHaveLength(1);
	});
	it("plano só com fonte em falha e sem seções é válido (a linha honesta)", () => {
		expect(parseDayPlanCard({ ...card, sections: [] })).toMatchObject({ sections: [], sourceErrors: [{ source: "calendar" }] });
	});
});
