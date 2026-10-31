import { describe, expect, it } from "vitest";
import { GROUP_NO_WAIT_RULE, buildGroupTurnPrompt, type GroupMember } from "./bot-group.js";
import { GROUP_NUDGE_RULE, GROUP_SUMMARY_MISSING_RULE, buildGroupRolePrompt } from "./bot-group-jev.js";
import { GROUP_SUMMARY_HOLD_MS } from "./bot-sla.js";
import { decideSummaryHold, describeMissingDeliveries, detectUndelivered, undeliveredError } from "./group-delivery.js";

describe("detectUndelivered", () => {
	it("pega o caso real: Inspetor pede o plano em vez de entregar", () => {
		expect(detectUndelivered("Se você me enviar o plano completo eu faço")).toBe("waiting");
		expect(detectUndelivered("Aguardando o plano completo do Radar para começar a inspeção.")).toBe("waiting");
		expect(detectUndelivered("I'm waiting for the full plan before I can start.")).toBe("waiting");
		expect(detectUndelivered("Preciso que você me passe o escopo da pesquisa.")).toBe("waiting");
	});

	it("pergunta curta no fim e resposta vazia contam como sem entrega", () => {
		expect(detectUndelivered("Qual segmento de mercado você quer analisar?")).toBe("asks_input");
		expect(detectUndelivered("Pode me dizer o prazo?\n")).toBe("asks_input");
		expect(detectUndelivered("")).toBe("empty");
		expect(detectUndelivered(null)).toBe("empty");
		expect(detectUndelivered("  \n ")).toBe("empty");
		expect(detectUndelivered("- ...")).toBe("empty");
	});

	it("não pega falso positivo: entrega curta, ou com pergunta de cortesia depois do conteúdo", () => {
		expect(detectUndelivered("Feito.")).toBeNull();
		expect(detectUndelivered("ok")).toBeNull();
		expect(detectUndelivered("Concorrentes: A, B, C (resumo curto). Quer que eu aprofunde algum?")).toBeNull();
		expect(detectUndelivered("Concorrentes: Alfa, Beta, Gama. Se precisar de mais, me envie o escopo.")).toBeNull();
		expect(detectUndelivered("Pode me dizer o prazo, por favor?")).toBe("asks_input");
		expect(detectUndelivered("Me diga o que você quer que eu faça.")).toBeNull();
	});

	it("entrega de verdade passa, mesmo curta ou com pergunta de cortesia no fim", () => {
		expect(detectUndelivered("Mercado de cafés especiais: R$ 4,2 bi em 2025, crescimento de 11% ao ano.")).toBeNull();
		const report = ["Resultado da pesquisa:", "- Tamanho: R$ 4,2 bi", "- Crescimento: 11% a.a.", "- Principais players: A, B, C", "- Riscos: câmbio", "- Suposições: base IBGE 2025", "Quer que eu aprofunde algum ponto?"].join("\n");
		expect(detectUndelivered(report)).toBeNull();
		expect(detectUndelivered(`${"Análise detalhada do mercado. ".repeat(30)} Aguardando feedback.`)).toBeNull();
	});
});

describe("decideSummaryHold", () => {
	const now = new Date("2026-10-31T12:00:00Z");
	const ago = (ms: number) => new Date(now.getTime() - ms);
	const base = { pendingBotIds: new Set<string>(), activeBotIds: new Set<string>(), now, holdMs: GROUP_SUMMARY_HOLD_MS };

	it("sem pendência ou continuação, não segura", () => {
		expect(decideSummaryHold({ ...base, workers: [{ botId: "a", finishedAt: ago(1000) }] })).toEqual({ hold: false, timedOut: [] });
	});

	it("cartão pendente ou run de continuação dentro do prazo segura o resumo", () => {
		expect(decideSummaryHold({ ...base, workers: [{ botId: "a", finishedAt: ago(60_000) }], pendingBotIds: new Set(["a"]) }).hold).toBe(true);
		expect(decideSummaryHold({ ...base, workers: [{ botId: "a", finishedAt: ago(60_000) }], activeBotIds: new Set(["a"]) }).hold).toBe(true);
	});

	it("passado o prazo o resumo segue e marca quem faltou; pendência de outro bot não segura", () => {
		const out = decideSummaryHold({ ...base, workers: [{ botId: "a", finishedAt: ago(GROUP_SUMMARY_HOLD_MS + 1) }], pendingBotIds: new Set(["a"]) });
		expect(out).toEqual({ hold: false, timedOut: ["a"] });
		expect(decideSummaryHold({ ...base, workers: [{ botId: "a", finishedAt: ago(1000) }], pendingBotIds: new Set(["zzz"]) }).hold).toBe(false);
	});

	it("um membro dentro do prazo segura mesmo que outro já tenha estourado", () => {
		const out = decideSummaryHold({
			...base,
			workers: [{ botId: "a", finishedAt: ago(GROUP_SUMMARY_HOLD_MS + 1) }, { botId: "b", finishedAt: ago(1000) }],
			pendingBotIds: new Set(["a", "b"]),
		});
		expect(out).toEqual({ hold: true, timedOut: [] });
	});
});

describe("describeMissingDeliveries", () => {
	const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);
	it("usa a tentativa mais recente de cada membro", () => {
		const rows = [
			{ botId: "a", createdAt: at(1), status: "done", error: undeliveredError("waiting") },
			{ botId: "a", createdAt: at(5), status: "done", error: null },
			{ botId: "b", createdAt: at(2), status: "done", error: undeliveredError("asks_input") },
			{ botId: "c", createdAt: at(3), status: "failed", error: "no_progress" },
			{ botId: "d", createdAt: at(4), status: "done", error: null },
		];
		expect(describeMissingDeliveries(rows)).toEqual([
			{ botId: "b", reason: "replied with a question instead of delivering" },
			{ botId: "c", reason: "did not finish in time" },
		]);
		expect(describeMissingDeliveries([{ botId: "e", createdAt: at(1), status: "failed", error: undeliveredError("still_running") }])[0]!.reason).toBe("was still running when the deadline came");
	});
});

describe("prompts: ninguém espera", () => {
	const members: GroupMember[] = [
		{ id: "ana", name: "Cookie", isPrimary: true },
		{ id: "bia", name: "Inspetor" },
	] as GroupMember[];

	it("coordenador e membro levam a regra de não esperar", () => {
		expect(buildGroupRolePrompt({ role: "coordinator", groupName: "G", members, selfId: "ana" })).toContain(GROUP_NO_WAIT_RULE);
		expect(buildGroupRolePrompt({ role: "worker", groupName: "G", members, selfId: "bia", subtask: "x" })).toContain(GROUP_NO_WAIT_RULE);
		expect(buildGroupTurnPrompt({ groupName: "G", reason: "bot_mention", fromName: "Cookie" })).toContain(GROUP_NO_WAIT_RULE);
		expect(GROUP_NO_WAIT_RULE).toMatch(/Never end with 'waiting for X'/);
	});

	it("a cobrança manda entregar com suposições; o resumo diz quem não entregou e nunca manda esperar", () => {
		const nudge = buildGroupRolePrompt({ role: "worker", groupName: "G", members, selfId: "bia", subtask: "inspecionar", nudge: true });
		expect(nudge).toContain(GROUP_NUDGE_RULE);
		expect(nudge).toMatch(/Do not wait; use the original request/);
		const summary = buildGroupRolePrompt({ role: "summary", groupName: "G", members, selfId: "ana", workerNames: ["Inspetor"], missing: [{ name: "Inspetor", reason: "replied with a question instead of delivering" }] });
		expect(summary).toContain("Inspetor did not deliver: replied with a question instead of delivering");
		expect(summary).toContain(GROUP_SUMMARY_MISSING_RULE);
		expect(GROUP_SUMMARY_MISSING_RULE).toMatch(/never say the next step is to wait/);
	});

	it("sem faltas, o resumo não inventa linha de falta", () => {
		const summary = buildGroupRolePrompt({ role: "summary", groupName: "G", members, selfId: "ana", workerNames: ["Inspetor"] });
		expect(summary).not.toContain("Not delivered");
	});
});
