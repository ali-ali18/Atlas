import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ENGINE_V4_TTL_MS, isEngineV4On, loadEngineV4, resetEngineV4Cache } from "./use-engine-v4";

beforeEach(() => resetEngineV4Cache());

const settings = (engineV4?: boolean) => ({ capabilities: { openrouterKey: true, isOwner: true, ...(engineV4 !== undefined && { engineV4 }) } });

test("só o sinal explícito do servidor liga; ausente, falso ou sem resposta desliga", () => {
	assert.equal(isEngineV4On(settings(true)), true);
	assert.equal(isEngineV4On(settings(false)), false);
	assert.equal(isEngineV4On(settings()), false);
	assert.equal(isEngineV4On(null), false);
});

test("uma única consulta serve todas as seções; falha vira desligado e tenta de novo depois", async () => {
	let calls = 0;
	const ok = async () => (calls++, settings(true));
	assert.equal(await loadEngineV4(ok), true);
	assert.equal(await loadEngineV4(ok), true);
	assert.equal(calls, 1);

	resetEngineV4Cache();
	assert.equal(await loadEngineV4(async () => Promise.reject(new Error("rede"))), false);
	assert.equal(await loadEngineV4(async () => settings(true)), true, "a falha não fica guardada");
});

test("a resposta vale por pouco tempo: depois do prazo (troca de conta/configuração) consulta de novo", async () => {
	let on = true;
	let calls = 0;
	const load = async () => (calls++, settings(on));
	assert.equal(await loadEngineV4(load, 1_000), true);
	on = false;
	assert.equal(await loadEngineV4(load, 1_000 + ENGINE_V4_TTL_MS - 1), true, "dentro do prazo, sem chamada nova");
	assert.equal(calls, 1);
	assert.equal(await loadEngineV4(load, 1_000 + ENGINE_V4_TTL_MS), false, "venceu: lê de novo");
	assert.equal(calls, 2);
});

test("resetEngineV4Cache (sair da conta) descarta a resposta da conta anterior", async () => {
	assert.equal(await loadEngineV4(async () => settings(true)), true);
	resetEngineV4Cache();
	assert.equal(await loadEngineV4(async () => settings(false)), false);
});
