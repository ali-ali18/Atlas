import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEF_FAILURE_LINE } from "@workspace/shared";
import {
	briefErrorTag,
	briefPushBody,
	createBriefFlusher,
	deliverBriefFailure,
	deliverDailyBrief,
	findRoutineRunIdWithRetry,
	flushPendingBriefs,
	isDetachedBriefRun,
	type BriefDeliveryDeps,
} from "./daily-brief.js";
import { runsDetachedFromChat } from "./processors/routine-defer.js";

type Row = { status: "pending" | "posted" | "expired" | null; text: string | null; botId: string; userId: string; pushed?: boolean };

/**
 * Armazém em memória com a mesma semântica do banco: mensagem com id determinístico (repetir = "exists") e
 * transições condicionais por dono. As garantias de SQL ficam em `brief-delivery.db.test.ts` (Postgres real).
 */
function fixture(overrides: Partial<BriefDeliveryDeps> = {}) {
	const rows = new Map<string, Row>();
	const messages = new Map<string, string>();
	const calls = { appended: [] as Array<[string, string]>, pushed: [] as Array<[string, string, string]>, expired: 0, recovered: 0, order: [] as string[] };
	let busy = false;
	const base: BriefDeliveryDeps = {
		conversationOf: async (botId, userId) => (botId === "bot-a" && userId === "user-a" ? "conv-a" : null),
		isBusy: async () => busy,
		appendMessage: async (_userId, conversationId, routineRunId, text) => {
			const key = routineRunId ?? `direct-${calls.appended.length}`;
			if (messages.has(key)) return "exists";
			messages.set(key, text);
			calls.appended.push([conversationId, text]);
			return "created";
		},
		push: async (userId, conversationId, text) => void (calls.order.push("push"), calls.pushed.push([userId, conversationId, text])),
		markPending: async (userId, id, text, mode) => {
			const row = rows.get(id) ?? { status: null, text: null, botId: "bot-a", userId };
			if (row.userId !== userId || (row.status !== null && row.status !== "pending")) return false;
			if (mode === "ifUnset" && row.status !== null) return false;
			calls.order.push("pending");
			rows.set(id, { ...row, status: "pending", text });
			return true;
		},
		claimPush: async (userId, id) => {
			const row = rows.get(id);
			if (!row || row.userId !== userId || row.pushed) return false;
			row.pushed = true;
			return true;
		},
		releasePush: async (_userId, id) => {
			const row = rows.get(id);
			if (row) row.pushed = false;
		},
		markPosted: async (userId, id) => {
			const row = rows.get(id);
			if (!row || row.userId !== userId || row.status !== "pending") return false;
			row.status = "posted";
			row.text = null;
			return true;
		},
	};
	const deps = { ...base, ...overrides };
	const flush = () =>
		flushPendingBriefs({
			...deps,
			expireStale: async () => calls.expired,
			recover: async () => calls.recovered,
			listPending: async () =>
				[...rows.entries()]
					.filter(([, row]) => row.status === "pending")
					.map(([routineRunId, row]) => ({ routineRunId, userId: row.userId, botId: row.botId, text: row.text ?? "", pushed: row.pushed ?? false, notify: "always" as const })),
		});
	return { calls, deps, rows, messages, flush, setBusy: (value: boolean) => void (busy = value) };
}

const TEXT = "Hoje você tem uma aula e um prazo.\n\n- 10h: aula de Estatística\n- Prazo às 23h59: trabalho de História";
const input = { routineRunId: "rr-1", userId: "user-a", botId: "bot-a", text: TEXT, notify: "always" as const };

test("conversa livre: o brief entra no chat na hora e o push leva a primeira linha", async () => {
	const { calls, deps, rows } = fixture();
	assert.deepEqual(await deliverDailyBrief(input, deps), { posted: true, pushed: true });
	assert.deepEqual(calls.appended, [["conv-a", TEXT]]);
	assert.deepEqual(calls.pushed, [["user-a", "conv-a", "Hoje você tem uma aula e um prazo."]]);
	assert.equal(rows.get("rr-1")?.status, "posted");
	assert.equal(rows.get("rr-1")?.text, null, "texto limpo ao postar");
});

test("conversa ocupada: o push sai na hora, o brief fica pendente e entra depois que a tarefa termina", async () => {
	const f = fixture();
	f.setBusy(true);
	const result = await deliverDailyBrief(input, f.deps);
	assert.equal(result.posted, false);
	assert.equal(result.pushed, true);
	assert.equal(f.calls.pushed.length, 1);
	assert.equal(f.calls.appended.length, 0);
	assert.equal(f.rows.get("rr-1")?.status, "pending");
	assert.equal(await f.flush(), 0, "ainda ocupada: a varredura não posta");
	f.setBusy(false);
	assert.equal(await f.flush(), 1);
	assert.deepEqual(f.calls.appended, [["conv-a", TEXT]]);
	assert.equal(f.calls.pushed.length, 1, "o push não se repete");
});

test("ordem: pendente primeiro, depois o push (o worker pode cair entre os dois sem perder o brief)", async () => {
	const f = fixture();
	await deliverDailyBrief(input, f.deps);
	assert.deepEqual(f.calls.order, ["pending", "push"]);
});

test("queda depois de guardar e antes do push: o texto está pendente e a varredura avisa uma vez só", async () => {
	const f = fixture();
	f.setBusy(true);
	const dying: BriefDeliveryDeps = { ...f.deps, claimPush: async () => { throw new Error("worker morreu"); } };
	const first = await deliverDailyBrief(input, dying);
	assert.equal(first.pushed, false);
	assert.equal(f.rows.get("rr-1")?.status, "pending", "o brief não se perdeu");
	assert.equal(f.calls.pushed.length, 0);
	assert.equal(await f.flush(), 0, "conversa ocupada: não posta, mas já avisa");
	assert.equal(f.calls.pushed.length, 1);
	f.setBusy(false);
	assert.equal(await f.flush(), 1);
	assert.equal(f.calls.pushed.length, 1, "a varredura nunca repete o push");
});

test("push que falhou devolve a reivindicação: a próxima varredura tenta de novo", async () => {
	let fail = true;
	const f = fixture();
	f.setBusy(true);
	const flaky: BriefDeliveryDeps = { ...f.deps, push: async (...args) => { if (fail) throw new Error("vapid"); return f.deps.push!(...args); } };
	assert.equal((await deliverDailyBrief(input, flaky)).pushed, false);
	fail = false;
	await flushPendingBriefs({ ...flaky, expireStale: async () => 0, listPending: async () => [{ routineRunId: "rr-1", userId: "user-a", botId: "bot-a", text: TEXT, pushed: false, notify: "always" }] });
	assert.equal(f.calls.pushed.length, 1);
});

test("a varredura não avisa pela linha de falha nem quando a rotina só avisa o importante", async () => {
	const f = fixture();
	f.rows.set("rr-f", { status: "pending", text: BRIEF_FAILURE_LINE, botId: "bot-a", userId: "user-a" });
	f.rows.set("rr-i", { status: "pending", text: "Resumo", botId: "bot-a", userId: "user-a" });
	await flushPendingBriefs({
		...f.deps,
		expireStale: async () => 0,
		listPending: async () => [
			{ routineRunId: "rr-f", userId: "user-a", botId: "bot-a", text: BRIEF_FAILURE_LINE, pushed: false, notify: "always" },
			{ routineRunId: "rr-i", userId: "user-a", botId: "bot-a", text: "Resumo", pushed: false, notify: "important" },
		],
	});
	assert.equal(f.calls.pushed.length, 0);
	assert.equal(f.calls.appended.length, 2);
});

test("recuperação: a varredura chama a recuperação de run concluído sem estado e registra a contagem", async () => {
	const f = fixture();
	f.calls.recovered = 3;
	const logged: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => void logged.push(args.join(" "));
	try {
		await f.flush();
	} finally {
		console.warn = original;
	}
	assert.ok(logged.some((line) => /3 brief\(s\) recuperado/.test(line)));
});

test("catch-up da varredura: brief pendente (worker caiu antes de postar) entra uma vez, sem duplicar", async () => {
	const f = fixture();
	f.rows.set("rr-9", { status: "pending", text: "Resumo", botId: "bot-a", userId: "user-a" });
	assert.equal(await f.flush(), 1);
	assert.equal(await f.flush(), 0);
	assert.deepEqual(f.calls.appended, [["conv-a", "Resumo"]]);
});

test("sem duplicar: fim de run e varredura disputando o mesmo brief deixam uma mensagem só", async () => {
	const f = fixture();
	f.setBusy(true);
	await deliverDailyBrief(input, f.deps);
	f.setBusy(false);
	await Promise.all([f.flush(), f.flush(), f.flush()]);
	assert.equal(f.calls.appended.length, 1);
	assert.equal(f.rows.get("rr-1")?.status, "posted");
});

test("queda entre gravar e marcar: a varredura vê a mensagem existente, marca postado e não duplica", async () => {
	let failMark = true;
	const f = fixture();
	const flaky = { ...f.deps, markPosted: async (u: string, id: string) => { if (failMark) throw new Error("db caiu"); return f.deps.markPosted(u, id); } };
	const first = await deliverDailyBrief(input, flaky);
	assert.equal(first.posted, true, "a mensagem entrou");
	assert.equal(f.rows.get("rr-1")?.status, "pending", "mas o estado não virou");
	failMark = false;
	assert.equal(await f.flush(), 0, "re-varredura: mensagem já existia, nada novo entra");
	assert.equal(f.calls.appended.length, 1);
	assert.equal(f.rows.get("rr-1")?.status, "posted");
});

test("gravação da mensagem falhou: segue pendente e a próxima varredura entrega", async () => {
	let fail = true;
	const f = fixture();
	const flaky: BriefDeliveryDeps = { ...f.deps, appendMessage: async (...args) => { if (fail) throw new Error("db fora"); return f.deps.appendMessage(...args); } };
	assert.equal((await deliverDailyBrief(input, flaky)).posted, false);
	assert.equal(f.rows.get("rr-1")?.status, "pending");
	fail = false;
	assert.equal(await flushPendingBriefs({ ...flaky, expireStale: async () => 0, listPending: async () => [{ routineRunId: "rr-1", userId: "user-a", botId: "bot-a", text: TEXT }] }), 1);
	assert.equal(f.calls.appended.length, 1);
});

test("a ocupação é conferida logo antes de gravar (corrida entre checagem e inserção)", async () => {
	const f = fixture();
	let checks = 0;
	const racing: BriefDeliveryDeps = { ...f.deps, isBusy: async () => { checks += 1; return true; } };
	const result = await deliverDailyBrief(input, racing);
	assert.equal(result.posted, false);
	assert.equal(checks, 1);
	assert.equal(f.calls.appended.length, 0);
});

test("push sai antes de qualquer consulta da execução: sem routineRunId o push vai e o brief é postado direto", async () => {
	const f = fixture();
	const result = await deliverDailyBrief({ ...input, routineRunId: null }, f.deps);
	assert.equal(result.pushed, true);
	assert.equal(result.posted, true);
	assert.equal(f.calls.pushed.length, 1);
	assert.deepEqual(f.calls.appended, [["conv-a", TEXT]]);
	assert.equal(f.rows.size, 0, "sem estado para guardar");
});

test("entrega direta (sem execução da rotina) com a conversa ocupada: o push sai e a mensagem não corta o bot", async () => {
	const f = fixture();
	f.setBusy(true);
	const result = await deliverDailyBrief({ ...input, routineRunId: null }, f.deps);
	assert.equal(result.pushed, true);
	assert.equal(result.posted, false);
	assert.equal(f.calls.appended.length, 0);
});

test("findRoutineRunIdWithRetry: tenta até 3 vezes com espera e devolve o id; esgotou = null", async () => {
	const waits: number[] = [];
	const sleep = async (ms: number) => void waits.push(ms);
	let calls = 0;
	const id = await findRoutineRunIdWithRetry(
		async () => {
			calls += 1;
			if (calls === 1) throw new Error("db");
			return calls === 2 ? undefined : "rr-1";
		},
		{ sleep },
	);
	assert.equal(id, "rr-1");
	assert.equal(calls, 3);
	assert.equal(waits.length, 2);
	calls = 0;
	assert.equal(await findRoutineRunIdWithRetry(async () => (calls += 1, null), { sleep }), null);
	assert.equal(calls, 3);
});

test("estado não pôde ser guardado (brief já tratado): não posta de novo", async () => {
	const f = fixture();
	f.rows.set("rr-1", { status: "posted", text: null, botId: "bot-a", userId: "user-a" });
	const result = await deliverDailyBrief(input, f.deps);
	assert.equal(result.posted, false);
	assert.equal(f.calls.appended.length, 0);
});

test("expiração: a varredura chama a expiração e registra a contagem sem texto do brief", async () => {
	const f = fixture();
	f.calls.expired = 2;
	const logged: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => void logged.push(args.join(" "));
	try {
		await f.flush();
	} finally {
		console.warn = original;
	}
	assert.equal(logged.length, 1);
	assert.match(logged[0]!, /2 brief\(s\) expirado/);
});

test("rotina com aviso 'só importante' não manda push (o brief ainda entra no chat)", async () => {
	const { calls, deps } = fixture();
	assert.deepEqual(await deliverDailyBrief({ ...input, notify: "important" }, deps), { posted: true, pushed: false });
	assert.equal(calls.pushed.length, 0);
});

test("falha do push não impede a mensagem; sem chave de push também segue", async () => {
	const failing = fixture({ push: async () => { throw new Error("vapid"); } });
	assert.deepEqual(await deliverDailyBrief(input, failing.deps), { posted: true, pushed: false });
	const noPush = fixture({ push: undefined });
	assert.deepEqual(await deliverDailyBrief(input, noPush.deps), { posted: true, pushed: false });
});

test("sem bot ou bot de outro dono: não entrega nem guarda nada", async () => {
	const { calls, deps, rows } = fixture();
	assert.equal((await deliverDailyBrief({ ...input, botId: null }, deps)).posted, false);
	assert.deepEqual(await deliverDailyBrief({ ...input, userId: "user-b" }, deps), { posted: false, pushed: false, reason: "bot sem conversa" });
	assert.equal(calls.appended.length + calls.pushed.length + rows.size, 0);
});

test("a varredura respeita o dono: bot de outro usuário não resolve conversa e nada é postado", async () => {
	const f = fixture();
	f.rows.set("rr-x", { status: "pending", text: "Resumo", botId: "bot-a", userId: "user-b" });
	assert.equal(await f.flush(), 0);
	assert.equal(f.calls.appended.length, 0);
});

test("logs de erro levam só nome e código, nunca a mensagem (pode embutir o texto do brief)", async () => {
	const secret = "TEXTO SECRETO DO BRIEF";
	const error = Object.assign(new Error(`Invalid prisma.create() ${secret}`), { name: "PrismaClientKnownRequestError", code: "P2002" });
	assert.equal(briefErrorTag(error), "PrismaClientKnownRequestError/P2002");
	const f = fixture({ appendMessage: async () => { throw error; } });
	const logged: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
	try {
		await deliverDailyBrief(input, f.deps);
	} finally {
		console.error = original;
	}
	assert.ok(logged.length > 0);
	assert.ok(logged.every((line) => !line.includes(secret) && !line.includes(TEXT)));
});

test("briefPushBody: primeira linha não vazia, com limite", () => {
	assert.equal(briefPushBody("\n  Primeira linha  \nsegunda"), "Primeira linha");
	assert.ok(briefPushBody("x".repeat(500)).length <= 180);
});

test("isDetachedBriefRun: run de rotina sem conversa é brief (falha fechada, sem depender do banco)", () => {
	assert.equal(isDetachedBriefRun({ origin: "routine", conversationId: null }), true);
	assert.equal(isDetachedBriefRun({ origin: "routine" }), true);
	assert.equal(isDetachedBriefRun({ origin: "routine", conversationId: "c" }), false);
	assert.equal(isDetachedBriefRun({ origin: "chat", conversationId: null }), false);
	assert.equal(isDetachedBriefRun({ origin: "proactive", conversationId: null }), false);
});

test("runsDetachedFromChat: só o modelo daily_brief", () => {
	assert.equal(runsDetachedFromChat("daily_brief"), true);
	assert.equal(runsDetachedFromChat("github_security_review"), false);
	assert.equal(runsDetachedFromChat(null), false);
	assert.equal(runsDetachedFromChat(undefined), false);
});

test("createBriefFlusher: chamadas simultâneas dividem uma varredura só", async () => {
	let runs = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const flusher = createBriefFlusher(async () => {
		runs += 1;
		await gate;
		return 1;
	});
	const all = Promise.all([flusher(), flusher(), flusher()]);
	release();
	assert.deepEqual(await all, [1, 1, 1]);
	assert.equal(runs, 1);
	await flusher();
	assert.equal(runs, 2, "depois de terminar, a próxima chamada varre de novo");
});

test("run sem texto (voltou vazio ou orçamento esgotado): posta e avisa a linha fixa de falha", async () => {
	const f = fixture();
	const result = await deliverDailyBrief({ ...input, text: "  " }, f.deps);
	assert.deepEqual(result, { posted: true, pushed: true });
	assert.deepEqual(f.calls.appended, [["conv-a", BRIEF_FAILURE_LINE]]);
	assert.deepEqual(f.calls.pushed, [["user-a", "conv-a", BRIEF_FAILURE_LINE]]);
	assert.equal(BRIEF_FAILURE_LINE, "Não consegui montar seu resumo de hoje.");
});

test("falha de vez do run: a linha entra no chat sem push próprio (o routine-failed já avisa) e uma vez só", async () => {
	const f = fixture();
	const run = { id: "ar-1", origin: "routine", conversationId: null, userId: "user-a", botId: "bot-a" };
	const io = { findRoutineRunId: async () => "rr-1", delivery: f.deps };
	await deliverBriefFailure(run, io);
	await deliverBriefFailure(run, io);
	assert.deepEqual(f.calls.appended, [["conv-a", BRIEF_FAILURE_LINE]]);
	assert.equal(f.calls.pushed.length, 0, "sem push duplicado");
	assert.equal(f.rows.get("rr-1")?.status, "posted");
});

test("falha do run depois de o brief já ter entrado: não posta a linha por cima", async () => {
	const f = fixture();
	await deliverDailyBrief(input, f.deps);
	await deliverBriefFailure({ id: "ar-1", origin: "routine", conversationId: null, userId: "user-a", botId: "bot-a" }, { findRoutineRunId: async () => "rr-1", delivery: f.deps });
	assert.equal(f.calls.appended.length, 1);
	assert.equal(f.calls.appended[0]![1], TEXT);
});

test("ordem 1: linha de falha pendente e depois o brief de verdade: o de verdade troca o texto", async () => {
	const f = fixture();
	f.setBusy(true);
	const run = { id: "ar-1", origin: "routine", conversationId: null, userId: "user-a", botId: "bot-a" };
	await deliverBriefFailure(run, { findRoutineRunId: async () => "rr-1", delivery: f.deps });
	assert.equal(f.rows.get("rr-1")?.text, BRIEF_FAILURE_LINE);
	await deliverDailyBrief(input, f.deps);
	assert.equal(f.rows.get("rr-1")?.text, TEXT, "o brief real substituiu a linha pendente");
	assert.equal(f.calls.pushed.length, 1, "e o push do brief real sai");
	f.setBusy(false);
	await f.flush();
	assert.deepEqual(f.calls.appended, [["conv-a", TEXT]]);
});

test("ordem 2: brief de verdade pendente e depois a linha de falha: a linha não sobrescreve", async () => {
	const f = fixture();
	f.setBusy(true);
	await deliverDailyBrief(input, f.deps);
	await deliverBriefFailure({ id: "ar-1", origin: "routine", conversationId: null, userId: "user-a", botId: "bot-a" }, { findRoutineRunId: async () => "rr-1", delivery: f.deps });
	assert.equal(f.rows.get("rr-1")?.text, TEXT);
	f.setBusy(false);
	await f.flush();
	assert.deepEqual(f.calls.appended, [["conv-a", TEXT]]);
});

test("linha de falha só em run de brief; consulta que falha ou erro nunca lançam", async () => {
	const f = fixture();
	await deliverBriefFailure({ id: "ar-2", origin: "chat", conversationId: "c", userId: "user-a", botId: "bot-a" }, { findRoutineRunId: async () => "rr-2", delivery: f.deps });
	await deliverBriefFailure({ id: "ar-3", origin: "routine", conversationId: null, userId: "user-a", botId: "bot-a" }, { findRoutineRunId: async () => { throw new Error("db"); }, delivery: f.deps });
	assert.deepEqual(f.calls.appended, [["conv-a", BRIEF_FAILURE_LINE]], "sem id da execução, posta direto (melhor esforço)");
	const broken = fixture({ conversationOf: async () => { throw new Error("db"); } });
	await deliverBriefFailure({ id: "ar-4", origin: "routine", conversationId: null, userId: "user-a", botId: "bot-a" }, { findRoutineRunId: async () => "rr-4", delivery: broken.deps });
});
