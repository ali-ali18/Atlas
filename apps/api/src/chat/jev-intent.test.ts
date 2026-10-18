import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@workspace/db";
import { buildJevIntent } from "./jev-intent.js";
import { maybeHandleConfirmedAction } from "./confirmed-action.js";

function stubFetch(answers: Record<string, number>) {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		calls += 1;
		const questions = Object.keys(JSON.parse(String(init?.body)).questions);
		return new Response(
			JSON.stringify({
				model: "typesafe/jev-1.13",
				answers: Object.fromEntries(questions.map((key) => [key, { type: "noul", noul: answers[key] ?? 0 }])),
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	return { calls: () => calls, restore: () => { globalThis.fetch = original; } };
}

test("buildJevIntent: sem chave ou com JEV_INTENT_MODE off não cria o detector", () => {
	assert.equal(buildJevIntent("key", {}), undefined);
	assert.equal(buildJevIntent(undefined, { JEV_INTENT_MODE: "on" }), undefined);
	assert.equal(buildJevIntent("key", { JEV_INTENT_MODE: "off" }), undefined);
});

test("buildJevIntent: on reconhece cancelar em espanhol; confirmar exige confiança alta", async () => {
	const fetchStub = stubFetch({ cancel: 0.95, confirm: 0.85 });
	try {
		const detect = buildJevIntent("key", { JEV_INTENT_MODE: "on" });
		assert.ok(detect);
		assert.deepEqual(await detect("cancela eso"), { cancel: true, confirm: false });
		assert.equal(fetchStub.calls(), 1);
	} finally {
		fetchStub.restore();
	}
});

test("buildJevIntent: falha do Jev = indisponível (null), para o chamador usar o fallback", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
	try {
		const detect = buildJevIntent("key", { JEV_INTENT_MODE: "on" });
		assert.equal(await detect!("cancela eso"), null);
	} finally {
		globalThis.fetch = original;
	}
});

function stubPending(kind: "confirm" | null) {
	const orig = {
		find: prisma.skillPendingIntent.findUnique,
		del: prisma.skillPendingIntent.deleteMany,
		msgs: prisma.conversationMessage.findMany,
		conv: prisma.conversation.findFirst,
	};
	const cleared: unknown[] = [];
	prisma.skillPendingIntent.findUnique = (async () =>
		kind
			? { id: "p1", userId: "user-a", conversationId: "c1", kind, payload: { action: "mcp-call", confirmId: "confirm-1" }, expiresAt: new Date(Date.now() + 60_000) }
			: null) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async (args: unknown) => {
		cleared.push(args);
		return { count: 1 };
	}) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => []) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversation.findFirst = (async () => null) as unknown as typeof prisma.conversation.findFirst;
	return {
		cleared,
		restore() {
			prisma.skillPendingIntent.findUnique = orig.find;
			prisma.skillPendingIntent.deleteMany = orig.del;
			prisma.conversationMessage.findMany = orig.msgs;
			prisma.conversation.findFirst = orig.conv;
		},
	};
}

const base = { userId: "user-a", botId: "bot-a", conversationId: "c1", model: "m" };

test("com card pendente, cancelar em outro idioma (Jev) limpa a intenção pendente", async () => {
	const db = stubPending("confirm");
	try {
		const asked: string[] = [];
		await maybeHandleConfirmedAction({
			...base,
			text: "olvídalo",
			jevIntent: async (text) => {
				asked.push(text);
				return { cancel: true, confirm: false };
			},
		}).catch(() => undefined); // a criação do run exige banco real; o que importa é o caminho de cancelar
		assert.deepEqual(asked, ["olvídalo"]);
		assert.equal(db.cleared.length, 1);
	} finally {
		db.restore();
	}
});

test("o Jev não é consultado para os tokens dos botões do card, nem sem card pendente", async () => {
	const db = stubPending("confirm");
	try {
		let calls = 0;
		const jevIntent = async () => {
			calls += 1;
			return { cancel: false, confirm: false };
		};
		await maybeHandleConfirmedAction({ ...base, text: "cancela isso", jevIntent }).catch(() => undefined);
		await maybeHandleConfirmedAction({ ...base, text: "confirmado: Google Agenda: executar create_event?", jevIntent }).catch(() => undefined);
		await maybeHandleConfirmedAction({ ...base, text: "confirmado sempre: Google Agenda", jevIntent }).catch(() => undefined);
		assert.equal(calls, 0);
	} finally {
		db.restore();
	}
	const none = stubPending(null);
	try {
		let calls = 0;
		const result = await maybeHandleConfirmedAction({
			...base,
			text: "olvídalo",
			jevIntent: async () => {
				calls += 1;
				return { cancel: true, confirm: false };
			},
		});
		assert.equal(result.handled, false);
		assert.equal(calls, 0);
	} finally {
		none.restore();
	}
});

/** Texto digitado: quem decide é o Jev; o regex pt só vale quando o Jev está indisponível. */
async function acceptRuns(text: string, jevIntent?: (t: string) => Promise<{ cancel: boolean; confirm: boolean } | null>) {
	const db = stubPending("confirm");
	// A criação do run começa validando o dono da conversa: contar essa consulta mostra que o aceite rodou.
	const original = prisma.conversation.findFirst;
	let runs = 0;
	prisma.conversation.findFirst = (async () => {
		runs += 1;
		return null;
	}) as unknown as typeof prisma.conversation.findFirst;
	try {
		await maybeHandleConfirmedAction({ ...base, text, jevIntent }).catch(() => undefined);
		return { runs, cleared: db.cleared.length };
	} finally {
		prisma.conversation.findFirst = original;
		db.restore();
	}
}

test("texto digitado: o Jev confirma em outro idioma e o fluxo de aceite roda", async () => {
	const result = await acceptRuns("sí, hazlo", async () => ({ cancel: false, confirm: true }));
	assert.deepEqual(result, { runs: 1, cleared: 0 });
});

test("texto digitado: Jev disponível manda, mesmo que o regex pt aceitasse", async () => {
	const result = await acceptRuns("sim", async () => ({ cancel: false, confirm: false }));
	assert.deepEqual(result, { runs: 0, cleared: 0 });
});

test("texto digitado: Jev indisponível (null) cai no regex pt como fallback", async () => {
	assert.deepEqual(await acceptRuns("sim", async () => null), { runs: 1, cleared: 0 });
	assert.deepEqual(await acceptRuns("sim"), { runs: 1, cleared: 0 });
	assert.deepEqual(await acceptRuns("sí, hazlo", async () => null), { runs: 0, cleared: 0 });
});

test("token do botão aceita sem Jev e nunca por texto livre longo", async () => {
	const never = async () => {
		throw new Error("não deve chamar o Jev");
	};
	assert.deepEqual(await acceptRuns("confirmado: criar evento?", never), { runs: 1, cleared: 0 });
});
