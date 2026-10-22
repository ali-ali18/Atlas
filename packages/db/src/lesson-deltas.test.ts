import assert from "node:assert/strict";
import { test } from "node:test";
import type { LessonDelta } from "@workspace/shared";
import { chooseDuplicateLosers, pickEvictions, planLessonDeltas, resolveLesson, type PlanLesson } from "./lesson-deltas.js";

const T0 = new Date("2026-10-01T00:00:00Z");
function lesson(id: string, over: Partial<PlanLesson> = {}): PlanLesson {
	return { id, scope: "bot", scopeKey: null, content: `Ao agir ${id}, faça X — porque Y`, origin: "correction", evidence: null, helpful: 0, harmful: 0, uses: 0, version: 1, lastUsedAt: null, createdAt: T0, updatedAt: T0, ...over };
}
const A = lesson("cmaaaa1a1a1");
const B = lesson("cmbbbb2b2b2", { helpful: 2 });
const active = [A, B];

test("o mesmo estado e os mesmos deltas geram sempre o mesmo plano", () => {
	const deltas: LessonDelta[] = [
		{ op: "add", scope: "connector", scopeKey: "mcp:c1", content: "Ao listar, passe o id interno — porque o de exibição falha", origin: "failure_recovery" },
		{ op: "update", id: B.id, content: "Ao agir B, faça Z — porque W" },
		{ op: "helpful", id: A.id },
	];
	assert.deepEqual(planLessonDeltas(active, deltas), planLessonDeltas(active, deltas));
});

test("deltas de contador não dependem da ordem e se somam", () => {
	const one = planLessonDeltas(active, [{ op: "helpful", id: A.id }, { op: "harmful", id: B.id }, { op: "helpful", id: A.id }]);
	const two = planLessonDeltas(active, [{ op: "harmful", id: B.id }, { op: "helpful", id: A.id }, { op: "helpful", id: A.id }]);
	assert.deepEqual(one.ops, two.ops);
	assert.deepEqual(one.ops.find((op) => op.type === "counter" && op.id === A.id), { type: "counter", id: A.id, helpful: 2, harmful: 0 });
});

test("update cria versão nova que substitui a anterior, mantendo contadores", () => {
	const plan = planLessonDeltas(active, [{ op: "update", id: B.id, content: "Ao agir B, faça Z — porque W" }, { op: "harmful", id: B.id }]);
	const create = plan.ops.find((op) => op.type === "create");
	assert.ok(create && create.type === "create");
	assert.equal(create.data.supersedesId, B.id);
	assert.equal(create.data.version, 2);
	assert.equal(create.data.helpful, 2);
	assert.equal(create.data.harmful, 1);
	assert.ok(plan.ops.some((op) => op.type === "retire" && op.id === B.id));
	assert.ok(!plan.ops.some((op) => op.type === "counter"), "o contador vai para a versão nova");
	assert.equal(plan.activeAfter, 2);
});

test("retire vence o update; update sem mudança e ids desconhecidos são recusados", () => {
	const plan = planLessonDeltas(active, [
		{ op: "update", id: A.id, content: "outra coisa — porque sim" },
		{ op: "retire", id: A.id },
		{ op: "update", id: B.id, content: B.content },
		{ op: "helpful", id: "cmzzzz9z9z9" },
	]);
	assert.deepEqual(plan.ops, [{ type: "retire", id: A.id }]);
	assert.deepEqual(plan.rejected.map((item) => item.reason), ["sem mudança", "lição não encontrada"]);
	assert.equal(plan.activeAfter, 1);
});

test("add recusa vazia, duplicada (no estado ou no lote) e escopo sem chave", () => {
	const plan = planLessonDeltas(active, [
		{ op: "add", scope: "bot", content: "  ", origin: "user" },
		{ op: "add", scope: "bot", content: A.content.toUpperCase(), origin: "user" },
		{ op: "add", scope: "tool", scopeKey: null, content: "Ao chamar T, passe o campo — porque falha", origin: "failed_action" },
		{ op: "add", scope: "tool", scopeKey: "mcp__x__t", content: "Ao chamar T, passe o campo — porque falha", origin: "failed_action" },
		{ op: "add", scope: "tool", scopeKey: "mcp__x__t", content: "ao chamar t, passe o campo — porque falha", origin: "failed_action" },
	]);
	assert.equal(plan.counts.added, 1);
	assert.deepEqual(plan.rejected.map((item) => item.reason), ["conteúdo vazio", "duplicada", "escopo sem chave", "duplicada"]);
});

test("a mesma frase em escopos diferentes não é duplicada", () => {
	const plan = planLessonDeltas(active, [{ op: "add", scope: "connector", scopeKey: "mcp:c1", content: A.content, origin: "reflection" }]);
	assert.equal(plan.counts.added, 1);
});

test("ref curta resolve; ref ambígua não", () => {
	assert.equal(resolveLesson(active, "La1a1")?.id, A.id);
	assert.equal(resolveLesson(active, A.id)?.id, A.id);
	const clash = [lesson("cmxxxxa1a1"), lesson("cmyyyya1a1")];
	assert.equal(resolveLesson(clash, "La1a1"), null);
});

test("pickEvictions tira primeiro as de menor saldo e menos usadas", () => {
	const rows = [
		lesson("c1", { helpful: 3, createdAt: T0 }),
		lesson("c2", { harmful: 2, createdAt: T0 }),
		lesson("c3", { createdAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z") }),
		lesson("c4", { createdAt: new Date("2026-10-05T00:00:00Z"), updatedAt: new Date("2026-10-05T00:00:00Z") }),
	];
	assert.deepEqual(pickEvictions(rows, 2).map((row) => row.id), ["c2", "c3"]);
	assert.deepEqual(pickEvictions(rows, 0), []);
});

test("chooseDuplicateLosers tira o pior de cada par, por distância, sem repetir", () => {
	const rows = [lesson("d1", { helpful: 5 }), lesson("d2"), lesson("d3", { helpful: 1 }), lesson("d4")];
	const pairs = [{ a: "d2", b: "d3", distance: 0.05 }, { a: "d1", b: "d2", distance: 0.01 }, { a: "d3", b: "d4", distance: 0.02 }];
	assert.deepEqual(chooseDuplicateLosers(rows, pairs, 1), ["d2"]);
	assert.deepEqual(chooseDuplicateLosers(rows, pairs, 5).sort(), ["d2", "d4"]);
});

test("a regra (hooks) vai junto no add e continua na versão nova quando o texto é editado", () => {
	const rule = { kind: "confirm_always" as const, tool: "mcp__erp__create_order" };
	const added = planLessonDeltas(active, [{ op: "add", scope: "tool", scopeKey: "mcp__erp__create_order", content: "Ao criar pedido, confirme sempre — porque o usuário pediu", origin: "user", rule }]);
	const create = added.ops.find((op) => op.type === "create");
	assert.ok(create && create.type === "create");
	assert.deepEqual(create.data.rule, rule);
	const withRule = lesson("cmcccc3c3c3", { rule });
	const edited = planLessonDeltas([withRule], [{ op: "update", id: withRule.id, content: "Ao criar pedido, confirme com o usuário — porque ele pediu" }]);
	const next = edited.ops.find((op) => op.type === "create");
	assert.ok(next && next.type === "create");
	assert.deepEqual(next.data.rule, rule);
	const plain = planLessonDeltas(active, [{ op: "update", id: B.id, content: "Ao agir B, faça Z — porque W" }]).ops.find((op) => op.type === "create");
	assert.ok(plain && plain.type === "create");
	assert.equal(plain.data.rule, null);
});
