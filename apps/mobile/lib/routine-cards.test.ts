import { describe, expect, it } from "vitest";
import { applyRunEvent, createLiveState, type LiveState } from "./chat-live";
import { parseChat, serializeChat } from "./chat-cache";
import { reconcile, sessionMessageToItem } from "./chat-thread";
import type { ChatItem, RoutineCardItem } from "./chat-types";
import { badgeFor, groupRoutineCards, ownState, routineGroupLabel, routineIcon, routineSummaryOf, settleRoutineCards, withRoutineCards } from "./routine-cards";

const persisted = (id: string, card: Record<string, unknown>, role = "routine", createdAt = "2026-11-02T10:00:00.000Z") => sessionMessageToItem({ id, conversationId: "c1", role, content: JSON.stringify({ v: 1, kind: role, ...card }), createdAt } as never);
const routine = (id: string, card: Record<string, unknown>) => persisted(id, { action: "updated", ...card }) as RoutineCardItem;
const created = (n: number): RoutineCardItem => routine(`m${n}`, { action: "created", routineId: `r${n}`, title: `Rotina ${n}`, triggerType: "cron", detail: "Cron: 0 8 * * 1 (America/Sao_Paulo)\nAtiva: sim\n\nfaça" });
const paused = (n: number): RoutineCardItem => routine(`p${n}`, { routineId: `r${n}`, title: `Rotina ${n}`, triggerType: "cron", detail: "Pausada" });
const deleted = (n: number): RoutineCardItem => routine(`d${n}`, { title: `Rotina ${n}`, triggerType: "cron", detail: `Apagada\nRotina ${n}` });
const talk = (id: string): ChatItem => ({ id, kind: "assistant", text: "ok" });

describe("cartão de rotina: do servidor ao item", () => {
	it("rotina por horário: frase do agendamento sem o cron cru", () => {
		const item = withRoutineCardsOne(created(1));
		expect(item.settled).toMatchObject({ state: "created", changed: false, summary: "Toda segunda às 8:00".replace("Toda segunda", "A cada segunda-feira") });
		expect(badgeFor(item)).toEqual({ tone: "success", label: "Criada" });
		expect(routineIcon(item)).toBe("schedule");
	});
	it("intervalo e uma vez usam a frase que o agente gravou", () => {
		expect(routineSummaryOf({ triggerType: "interval", action: "created", detail: "A cada 50 min\nRepete..." })).toBe("A cada 50 min");
		expect(routineSummaryOf({ triggerType: "once", action: "created", detail: "Uma vez · 03/10 às 10:00\nDispara" })).toBe("Uma vez · 03/10 às 10:00");
		expect(routineIcon({ triggerType: "once", detail: "Uma vez · 03/10 às 10:00" })).toBe("once");
	});
	it("webhook: sabe que é gatilho, nunca guarda a URL nem o secret", () => {
		const item = routine("w", { action: "created", routineId: "rw", title: "Deploy", triggerType: "event", detail: "Webhook: https://x/hook/abc\nSecret (guarde agora): s3cr3t\nHeader: X-Atlas-Hook-Secret: <secret>\n\nfaça", hookUrl: "https://x/hook/abc", hookSecret: "s3cr3t" });
		expect(item.hook).toBe(true);
		expect(JSON.stringify(item)).not.toContain("s3cr3t");
		expect(JSON.stringify(item)).not.toContain("x/hook");
		expect(routineIcon(item)).toBe("webhook");
		expect(routineSummaryOf(item)).toBe("Quando um webhook chamar");
	});
	it("e-mail, GitHub e alerta", () => {
		const email = routine("e", { action: "created", routineId: "re", title: "Faturas", triggerType: "event", detail: "Quando chegar e-mail de banco@x.com\n\nfaça" });
		expect(routineIcon(email)).toBe("email");
		expect(routineSummaryOf(email)).toBe("Quando chegar e-mail de banco@x.com");
		const git = routine("g", { action: "created", routineId: "rg", title: "PRs", triggerType: "event", detail: "GitHub: org/repo · pull_request\n\nfaça" });
		expect(routineIcon(git)).toBe("github");
		expect(routineSummaryOf(git)).toBe("GitHub · org/repo · pull_request");
		const alert = routine("a", { action: "created", routineId: "ra", title: "Preço", triggerType: "cron", detail: "Alerta · confere a cada 30 minutos · avisa se cair\nVerifica" });
		expect(routineIcon(alert)).toBe("alert");
		expect(routineSummaryOf(alert)).toBe("Alerta · confere a cada 30 minutos · avisa se cair");
	});
	it("estado de cada ação: pausada, retomada, apagada, aviso, edição", () => {
		const state = (detail: string) => ownState(routine("x", { routineId: "r", title: "R", detail }));
		expect(state("Pausada")).toBe("paused");
		expect(state("Retomada\nAlerta · …")).toBe("resumed");
		expect(state("Apagada\nR")).toBe("deleted");
		expect(state("Avisa a cada execução")).toBe("notify");
		expect(state("A cada 2 h\nRepete")).toBe("edited");
	});
	it("lista de rotinas e proposta do bot", () => {
		const listed = persisted("l", { action: "listed", items: [{ id: "r1", name: "A", triggerType: "cron", enabled: true, schedule: "0 9 * * 1-5" }, { id: "r2", name: "B", triggerType: "event", enabled: false }] }) as RoutineCardItem;
		expect(listed).toMatchObject({ kind: "routine", action: "listed", title: "Suas rotinas" });
		expect(listed.items).toHaveLength(2);
		const proposal = persisted("pr", { proposalId: "p1", mode: "suggest", status: "pending", spec: { name: "Resumo", prompt: "faça", schedule: "0 8 * * 1", timezone: "America/Sao_Paulo" } }, "routine-proposal");
		expect(proposal).toMatchObject({ kind: "routine-proposal", name: "Resumo", status: "pending", schedule: "Toda segunda às 8h" });
	});
});

function withRoutineCardsOne(item: ChatItem): RoutineCardItem {
	return settleRoutineCards([item])[0] as RoutineCardItem;
}

describe("o cartão reflete o estado atual", () => {
	it("criar 5 e depois apagar 5 = os mesmos 5 cartões, apagados; o cartão de exclusão não aparece", () => {
		const items = [...[1, 2, 3, 4, 5].map(created), talk("t"), ...[1, 2, 3, 4, 5].map(deleted)];
		const out = settleRoutineCards(items);
		expect(out).toHaveLength(6);
		expect(out.filter((item) => item.kind === "routine").every((item) => (item as RoutineCardItem).settled?.state === "deleted" && (item as RoutineCardItem).settled?.changed)).toBe(true);
		const grouped = withRoutineCards([...[1, 2, 3, 4, 5].map(created), ...[1, 2, 3, 4, 5].map(deleted)]);
		expect(grouped).toHaveLength(1);
		expect(routineGroupLabel(grouped[0] as never)).toEqual({ text: "5 rotinas apagadas", struck: true });
	});
	it("pausa com routineId muda o estado do cartão de criação", () => {
		const out = settleRoutineCards([created(1), paused(1)]);
		expect(out).toHaveLength(1);
		expect((out[0] as RoutineCardItem).settled).toMatchObject({ state: "paused", changed: true, summary: expect.stringContaining("8:00") });
	});
	it("pausa de rotina sem cartão anterior no fio fica como cartão", () => {
		const out = settleRoutineCards([paused(9)]);
		expect(out).toHaveLength(1);
		expect((out[0] as RoutineCardItem).settled).toMatchObject({ state: "paused", changed: false });
	});
	it("apagar só a 2 de 3 de mesmo nome casa a mais recente; nome repetido depois de apagada vale a nova", () => {
		const a = created(1);
		const again = { ...created(2), title: "Rotina 1" } as RoutineCardItem;
		const out = settleRoutineCards([a, again, deleted(1)]) as RoutineCardItem[];
		expect(out.map((item) => item.settled?.state)).toEqual(["created", "deleted"]);
	});
	it("a lista nunca é absorvida", () => {
		const listed = persisted("l", { action: "listed", items: [] }) as RoutineCardItem;
		expect(settleRoutineCards([created(1), listed, paused(1)])).toHaveLength(2);
	});
});

describe("agrupamento de cartões de rotina", () => {
	const kinds = (items: ChatItem[]) => items.map((item) => item.kind);
	it("1 cartão fica cartão; 2 já viram a linha; 3 e 7 também", () => {
		expect(kinds(withRoutineCards([paused(1)]))).toEqual(["routine"]);
		expect(kinds(withRoutineCards([paused(1), paused(2)]))).toEqual(["routine-group"]);
		expect(kinds(withRoutineCards([1, 2, 3].map(paused)))).toEqual(["routine-group"]);
		const seven = withRoutineCards([1, 2, 3, 4, 5, 6, 7].map(paused));
		expect(seven).toHaveLength(1);
		expect(routineGroupLabel(seven[0] as never)).toEqual({ text: "Pausou 7 rotinas", struck: false });
	});
	it("fala, outro cartão ou lista fecham o trecho", () => {
		const out = groupRoutineCards([paused(1), paused(2), talk("t"), paused(3), paused(4), paused(5)]);
		expect(kinds(out)).toEqual(["routine-group", "assistant", "routine-group"]);
		expect((out[2] as { items: unknown[] }).items).toHaveLength(3);
	});
	it("alerta e rotina não se misturam", () => {
		const alert = (n: number) => routine(`al${n}`, { action: "created", routineId: `ra${n}`, title: `Alerta ${n}`, triggerType: "cron", detail: "Alerta · confere a cada hora\nx" });
		const out = withRoutineCards([paused(1), paused(2), alert(1), alert(2)]);
		expect(kinds(out)).toEqual(["routine-group", "routine-group"]);
		expect(routineGroupLabel(out[1] as never).text).toBe("Criou 2 alertas");
	});
	it("estados misturados viram 'Alterou N'; criadas e retomadas dizem o verbo", () => {
		expect(routineGroupLabel(withRoutineCards([created(1), paused(2)])[0] as never).text).toBe("Alterou 2 rotinas");
		expect(routineGroupLabel(withRoutineCards([1, 2, 3, 4, 5].map(created))[0] as never).text).toBe("Criou 5 rotinas");
		const resumed = [1, 2].map((n) => routine(`rs${n}`, { routineId: `x${n}`, title: `X${n}`, detail: "Retomada" }));
		expect(routineGroupLabel(withRoutineCards(resumed)[0] as never).text).toBe("Retomou 2 rotinas");
	});
	it("exclusões novas (sem cartão de criação no fio) dizem 'Apagou N rotinas'", () => {
		expect(routineGroupLabel(withRoutineCards([deleted(1), deleted(2), deleted(3)])[0] as never)).toEqual({ text: "Apagou 3 rotinas", struck: false });
	});
	it("a identidade da linha é a da primeira rotina: igual ao vivo e gravado", () => {
		const a = withRoutineCards([1, 2, 3].map(paused))[0]!;
		const b = withRoutineCards([1, 2, 3].map((n) => ({ ...paused(n), id: `live-${n}` })))[0]!;
		expect(a.id).toBe(b.id);
	});
});

describe("ao vivo × gravado", () => {
	const event = (action: "created" | "updated", routineId: string | undefined, title: string, detail: string) => ({ type: "routine" as const, action, ...(routineId ? { routineId } : {}), title, detail, triggerType: "cron" as const });
	it("o evento ao vivo vira item e o repetido do stream não duplica", () => {
		let live: LiveState = createLiveState();
		live = { ...live, runId: "run1" };
		live = applyRunEvent(live, event("updated", "r1", "Rotina 1", "Pausada") as never);
		live = applyRunEvent(live, event("updated", "r1", "Rotina 1", "Pausada") as never);
		expect(live.items).toHaveLength(1);
		expect(live.items[0]).toMatchObject({ kind: "routine", title: "Rotina 1" });
	});
	it("criada ao vivo e já gravada = um cartão só", () => {
		let live: LiveState = { ...createLiveState(), runId: "run1" };
		live = applyRunEvent(live, event("created", "r1", "Rotina 1", "Cron: 0 8 * * 1 (America/Sao_Paulo)") as never);
		const out = reconcile([created(1)], live.items);
		expect(out.filter((item) => item.kind === "routine")).toHaveLength(1);
		expect(out[0]!.id).toBe("m1");
	});
	it("pausa ao vivo já gravada = um cartão só; pausar de novo depois (outra pausa gravada) continua valendo", () => {
		let live: LiveState = { ...createLiveState(), runId: "run1" };
		live = applyRunEvent(live, event("updated", "r1", "Rotina 1", "Pausada") as never);
		expect(reconcile([paused(1)], live.items)).toHaveLength(1);
		const twice = reconcile([paused(1), { ...paused(1), id: "p1b" }], []);
		expect(twice).toHaveLength(2);
	});
	it("pausa ao vivo ainda não gravada entra no fim e é absorvida pela criação", () => {
		let live: LiveState = { ...createLiveState(), runId: "run1" };
		live = applyRunEvent(live, event("updated", "r1", "Rotina 1", "Pausada") as never);
		const out = withRoutineCards(reconcile([created(1)], live.items));
		expect(out).toHaveLength(1);
		expect((out[0] as RoutineCardItem).settled?.state).toBe("paused");
	});
});

describe("cache do aparelho", () => {
	it("o cartão de rotina e a proposta voltam do disco; o segredo nunca vai", () => {
		const items = [created(1), paused(2), persisted("pr", { proposalId: "p1", mode: "auto", status: "accepted", routineId: "r7", spec: { name: "Resumo", prompt: "x", everyMinutes: 120, timezone: "UTC" } }, "routine-proposal")!];
		const back = parseChat(serializeChat(items, 1000), 1000);
		expect(back?.items.map((item) => item.kind)).toEqual(["routine", "routine", "routine-proposal"]);
		expect(back?.items[0]).toMatchObject({ title: "Rotina 1", routineId: "r1", action: "created" });
		expect(back?.items[2]).toMatchObject({ schedule: "A cada 2 horas", status: "accepted" });
	});
});
