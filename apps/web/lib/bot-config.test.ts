import assert from "node:assert/strict";
import test from "node:test";
import {
	isSameModelChoice,
	planModelPersist,
	planConfigClose,
	realignSnapshotModel,
	toConfigSnapshot,
	type ConfigSource,
} from "./bot-config";

const base: ConfigSource = {
	name: "Bot",
	snippet: "Ajuda",
	description: "",
	openRouterModel: "vendor/model-a",
	language: "pt-BR",
	color: "#fff",
	shape: null,
	policyJson: null,
};

test("fechar sem mudança não salva nada (0 chamadas)", () => {
	assert.equal(planConfigClose(toConfigSnapshot(base), { ...base }), null);
});

test("fechar com descrição editada só gera PATCH da descrição, sem run", () => {
	const plan = planConfigClose(toConfigSnapshot(base), {
		...base,
		description: "Cuida das finanças",
	});
	assert.ok(plan);
	assert.deepEqual(plan.changedKeys, ["description"]);
	assert.deepEqual(plan.patch, { description: "Cuida das finanças" });
	// O plano de fechamento é só persistência: nenhuma intenção de run/evento.
	assert.deepEqual(Object.keys(plan).sort(), ["changedKeys", "patch"]);
});

test("descrição apagada vira null no PATCH", () => {
	const plan = planConfigClose(
		toConfigSnapshot({ ...base, description: "x" }),
		{ ...base, description: "" },
	);
	assert.deepEqual(plan?.patch, { description: null });
});

test("A4: reselecionar o mesmo modelo não é mudança", () => {
	assert.equal(isSameModelChoice("vendor/model-a", " vendor/model-a "), true);
	assert.equal(isSameModelChoice(undefined, "vendor/model-a"), false);
	assert.equal(isSameModelChoice("vendor/model-a", "vendor/model-b"), false);
});

test("A4: modelo persistido na hora não volta a aparecer no diff ao fechar", () => {
	const snapshot = { botId: "b1", before: toConfigSnapshot(base) };
	const current = { ...base, openRouterModel: "vendor/model-b" };
	assert.ok(planConfigClose(snapshot.before, current));
	const realigned = realignSnapshotModel(snapshot, "b1", "vendor/model-b");
	assert.equal(planConfigClose(realigned.before, current), null);
});

test("A4: realinhar não mexe no snapshot de outro bot", () => {
	const snapshot = { botId: "b1", before: toConfigSnapshot(base) };
	assert.equal(realignSnapshotModel(snapshot, "b2", "x/y"), snapshot);
	assert.equal(realignSnapshotModel(null, "b1", "x/y"), null);
});

test("Automático (vazio) é escolha persistida: limpa o modelo fixo do bot com null", () => {
	assert.deepEqual(planModelPersist("vendor/model-a", ""), { model: "", apiValue: null });
	assert.deepEqual(planModelPersist("vendor/model-a", "  "), { model: "", apiValue: null });
});

test("planModelPersist: modelo concreto vai como string; sem mudança não persiste", () => {
	assert.deepEqual(planModelPersist(undefined, " vendor/model-b "), { model: "vendor/model-b", apiValue: "vendor/model-b" });
	assert.equal(planModelPersist(undefined, ""), null);
	assert.equal(planModelPersist(null, "  "), null);
	assert.equal(planModelPersist("vendor/model-a", "vendor/model-a"), null);
});
