import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isEngineV4On, loadEngineV4, resetEngineV4Cache } from "./use-engine-v4";

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
