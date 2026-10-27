import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutoBriefCandidate, AutoBriefSignals } from "@workspace/db";
import type { BriefSource } from "@workspace/shared";
import { createAutoBriefEnsurer, ensureAutoBrief, type AutoBriefDeps } from "./brief-auto.js";

const NOW = new Date("2026-10-27T15:00:00Z"); // 12:00 em São Paulo
const email: BriefSource = { kind: "composio", name: "Gmail", category: "email", readTools: ["GMAIL_FETCH"] };

const bot = (over: Partial<AutoBriefCandidate> = {}): AutoBriefCandidate => ({ id: "bot-a", ownerId: "user-a", conversationId: "conv-a", policyJson: null, ...over });
const activeDays = (hhmm: string, days = 6): Date[] =>
	Array.from({ length: days }, (_, index) => {
		const [h, m] = hhmm.split(":").map(Number) as [number, number];
		const day = new Date(NOW.getTime() - (index + 1) * 86_400_000);
		return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h! + 3, m!));
	});

/** Banco em memória: uma rotina "Seu dia" por bot, como o `createOnly` do upsert garante. */
function harness(over: Partial<AutoBriefDeps> & { sources?: BriefSource[]; signals?: AutoBriefSignals; bots?: AutoBriefCandidate[]; policy?: unknown } = {}) {
	const created: Array<{ userId: string; botId: string; createdBy?: string; schedule?: unknown; timezone?: unknown }> = [];
	const seen = { sources: [] as string[], signals: [] as string[], policy: [] as Array<[string, string]> };
	const existing = new Set<string>();
	const marks = new Map<string, string>();
	const deps: AutoBriefDeps = {
		now: () => NOW,
		minIntervalMs: 0,
		log: () => undefined,
		// Como o db: ordem de id, cursor, só quem ainda não tem rotina; a data gravada volta no policyJson.
		listCandidates: async ({ afterId, limit }) =>
			(over.bots ?? [bot()])
				.filter((candidate) => !existing.has(candidate.id) && (!afterId || candidate.id > afterId))
				.sort((a, b) => a.id.localeCompare(b.id))
				.slice(0, limit)
				.map((candidate) => (marks.has(candidate.id) ? { ...candidate, policyJson: { ...(candidate.policyJson as object | null), briefAutoCheckedAt: marks.get(candidate.id) } } : candidate)),
		markChecked: async (_userId, botId, day) => void marks.set(botId, day),
		listSources: async (userId) => (seen.sources.push(userId), over.sources ?? [email]),
		loadSignals: async ({ userId }) => (seen.signals.push(userId), over.signals ?? { userMessageAts: activeDays("08:40"), hasPendingWork: false }),
		accountTimezone: async () => "America/Sao_Paulo",
		readPolicy: async (botId, userId) => (seen.policy.push([botId, userId]), over.policy ?? null),
		withLock: async (_botId, fn) => fn(),
		upsert: (async (args: { schedule?: unknown; timezone?: unknown }, d: { userId: string; botId: string; createdBy?: string; createOnly?: boolean; onCreated?: (routine: never) => Promise<void> }) => {
			if (existing.has(d.botId)) return { created: false, routine: {}, sentence: "" };
			existing.add(d.botId);
			created.push({ userId: d.userId, botId: d.botId, createdBy: d.createdBy, schedule: args.schedule, timezone: args.timezone });
			assert.equal(d.createOnly, true, "o ensure nunca edita uma rotina existente");
			const routine = { id: `routine-${d.botId}` };
			await d.onCreated?.(routine as never);
			return { created: true, routine, sentence: "" };
		}) as never,
		...over,
	};
	return { deps, created, seen, existing, marks };
}

test("cria exatamente uma rotina por bot principal: todo dia, no horário da atividade, createdBy bot", async () => {
	const h = harness();
	assert.equal(await ensureAutoBrief(bot(), h.deps), "created");
	assert.deepEqual(h.created, [{ userId: "user-a", botId: "bot-a", createdBy: "bot", schedule: "10 8 * * *", timezone: "America/Sao_Paulo" }]);
});

test("depois de criar, agenda o cron da rotina (onCreated); rotina que já existia não é reagendada; falha ao agendar não derruba", async () => {
	const scheduled: unknown[] = [];
	const h = harness({ onCreated: async (routine) => void scheduled.push(routine) });
	assert.equal(await ensureAutoBrief(bot(), h.deps), "created");
	assert.equal(await ensureAutoBrief(bot(), h.deps), "exists");
	assert.deepEqual(scheduled, [{ id: "routine-bot-a" }], "agendou uma vez, na criação");

	const logs: string[] = [];
	const broken = harness({
		log: (line) => void logs.push(line),
		onCreated: async () => {
			throw new Error("redis fora");
		},
	});
	assert.equal(await ensureAutoBrief(bot(), broken.deps), "created", "a rotina existe; o agendamento é refeito no boot");
	assert.ok(logs.some((line) => line.includes("agendamento falhou")));
	assert.ok(!logs.join("\n").includes("redis fora"), "só o tipo do erro");
});

test("sem dados de atividade: 07:30 todo dia", async () => {
	const h = harness({ signals: { userMessageAts: [], hasPendingWork: false } });
	await ensureAutoBrief(bot(), h.deps);
	assert.equal(h.created[0]?.schedule, "30 7 * * *");
});

test("idempotente: rodar de novo não cria a segunda (nem na mesma varredura, nem em outra)", async () => {
	const h = harness();
	assert.equal(await ensureAutoBrief(bot(), h.deps), "created");
	assert.equal(await ensureAutoBrief(bot(), h.deps), "exists");
	const ensure = createAutoBriefEnsurer(h.deps);
	assert.equal(await ensure(), 0, "o candidato já tem rotina e sai da lista");
	assert.equal(h.created.length, 1);
});

test("nunca cria para bot com opt-out, com o modo proativo desligado, ou que não é principal", async () => {
	for (const policyJson of [{ briefOptOut: true }, { proactive: { enabled: false } }]) {
		const h = harness();
		assert.equal(await ensureAutoBrief(bot({ policyJson }), h.deps), "skipped_policy");
		assert.deepEqual(h.created, []);
		assert.deepEqual(h.seen.sources, [], "nem consulta fontes");
	}
	// modo proativo ligado, ou nunca mexido: vale
	assert.equal(await ensureAutoBrief(bot({ policyJson: { proactive: { enabled: true } } }), harness().deps), "created");
	// a lista só traz principais (db); o ensure também confere a política relida sob o lock
	const raced = harness({ policy: { briefOptOut: true } });
	assert.equal(await ensureAutoBrief(bot(), raced.deps), "skipped_policy", "opt-out que chegou durante a checagem vale");
	assert.deepEqual(raced.created, []);
});

test("bot sem conversa não ganha o brief (não teria onde entrar)", async () => {
	const h = harness();
	assert.equal(await ensureAutoBrief(bot({ conversationId: null }), h.deps), "skipped_no_conversation");
	assert.deepEqual(h.created, []);
});

test("sem fonte conectada e sem pendência: não cria; com pendência (follow-up/rotina) ou com fonte: cria", async () => {
	const none = harness({ sources: [], signals: { userMessageAts: [], hasPendingWork: false } });
	assert.equal(await ensureAutoBrief(bot(), none.deps), "skipped_no_sources");
	assert.deepEqual(none.created, []);
	const needsReconnectOnly = harness({ sources: [{ ...email, readTools: [], needsReconnect: true }], signals: { userMessageAts: [], hasPendingWork: false } });
	assert.equal(await ensureAutoBrief(bot(), needsReconnectOnly.deps), "skipped_no_sources");
	const pending = harness({ sources: [], signals: { userMessageAts: [], hasPendingWork: true } });
	assert.equal(await ensureAutoBrief(bot(), pending.deps), "created");
	const withSource = harness({ signals: { userMessageAts: [], hasPendingWork: false } });
	assert.equal(await ensureAutoBrief(bot(), withSource.deps), "created");
});

test("tudo vai escopado pelo dono do bot (outro usuário nunca entra)", async () => {
	const h = harness({ bots: [bot(), bot({ id: "bot-b", ownerId: "user-b", conversationId: "conv-b" })] });
	await createAutoBriefEnsurer(h.deps)();
	assert.deepEqual(h.created.map((row) => [row.botId, row.userId]), [["bot-a", "user-a"], ["bot-b", "user-b"]]);
	assert.deepEqual(h.seen.sources.sort(), ["user-a", "user-b"]);
	assert.deepEqual(h.seen.policy, [["bot-a", "user-a"], ["bot-b", "user-b"]]);
});

test("bot sem fonte: a data é gravada e só volta a ser checado depois de 7 dias (não todo ciclo)", async () => {
	let now = NOW;
	const h = harness({ sources: [], signals: { userMessageAts: [], hasPendingWork: false }, now: () => now });
	const ensure = createAutoBriefEnsurer(h.deps);
	await ensure();
	assert.deepEqual([...h.marks], [["bot-a", "2026-10-27"]]);
	for (const days of [1, 3, 6]) {
		now = new Date(NOW.getTime() + days * 86_400_000);
		await ensure();
	}
	assert.equal(h.seen.sources.length, 1, "nenhuma checagem com consulta nos próximos 6 dias");
	now = new Date(NOW.getTime() + 7 * 86_400_000);
	await ensure();
	assert.equal(h.seen.sources.length, 2, "uma semana depois tenta de novo");
	assert.equal(await ensureAutoBrief(bot({ policyJson: { briefAutoCheckedAt: "2026-11-03" } }), h.deps), "skipped_not_due");
});

test("orçamento por varredura com cursor: não lê todos os bots num ciclo e dá a volta no fim", async () => {
	const bots = ["a", "b", "c", "d", "e"].map((id) => bot({ id: `bot-${id}`, ownerId: `user-${id}`, conversationId: `conv-${id}` }));
	const h = harness({ bots, sources: [], signals: { userMessageAts: [], hasPendingWork: false } });
	const ensure = createAutoBriefEnsurer({ ...h.deps, maxChecksPerSweep: 2, pageSize: 2 });
	await ensure();
	assert.deepEqual(h.seen.sources, ["user-a", "user-b"], "só 2 checagens");
	await ensure();
	assert.deepEqual(h.seen.sources, ["user-a", "user-b", "user-c", "user-d"], "continua de onde parou");
	await ensure();
	assert.deepEqual(h.seen.sources.slice(4), ["user-e"], "fim da lista");
	await ensure();
	assert.equal(h.seen.sources.length, 5, "deu a volta: todos já têm a data gravada, nada gasta consulta");
});

test("bots que só pulam por política não gastam o orçamento; o limite de leitura também vale", async () => {
	const skipped = Array.from({ length: 6 }, (_, i) => bot({ id: `bot-s${i}`, ownerId: `user-s${i}`, policyJson: { briefOptOut: true } }));
	const real = bot({ id: "bot-z", ownerId: "user-z", conversationId: "conv-z" });
	const h = harness({ bots: [...skipped, real] });
	assert.equal(await createAutoBriefEnsurer({ ...h.deps, maxChecksPerSweep: 1, pageSize: 3 })(), 1, "pulou 6 sem gastar e criou o do fim");
	const limited = harness({ bots: [...skipped, real] });
	assert.equal(await createAutoBriefEnsurer({ ...limited.deps, maxScanPerSweep: 4, pageSize: 3 })(), 0, "parou depois de ler 4+ bots");
});

test("erro de vez não grava a data nem lança, e tenta de novo na próxima varredura", async () => {
	let fail = true;
	const h = harness({
		listSources: async () => {
			if (fail) throw new Error("db fora");
			return [email];
		},
	});
	const ensure = createAutoBriefEnsurer(h.deps);
	assert.equal(await ensure(), 0);
	assert.equal(h.marks.size, 0);
	fail = false;
	assert.equal(await ensure(), 1);
});

test("a varredura tem intervalo mínimo e não roda duas ao mesmo tempo", async () => {
	let n = 0;
	let t = NOW;
	const throttled = createAutoBriefEnsurer({ ...harness().deps, minIntervalMs: 30 * 60_000, now: () => t, listCandidates: async () => (n++, []) });
	await throttled();
	t = new Date(t.getTime() + 60_000);
	await throttled();
	assert.equal(n, 1, "a 2ª chamada em 1 min não consulta o banco");
	t = new Date(t.getTime() + 31 * 60_000);
	await throttled();
	assert.equal(n, 2);
});

test("silêncio configurado pelo usuário empurra o horário; o padrão do sistema não", async () => {
	const early = { userMessageAts: activeDays("06:40"), hasPendingWork: false };
	const quiet = harness({ signals: early });
	await ensureAutoBrief(bot({ policyJson: { proactive: { enabled: true, quietStart: "22:00", quietEnd: "08:00" } } }), quiet.deps);
	assert.equal(quiet.created[0]?.schedule, "0 8 * * *");
	const plain = harness({ signals: early });
	await ensureAutoBrief(bot(), plain.deps);
	assert.equal(plain.created[0]?.schedule, "10 6 * * *");
});
