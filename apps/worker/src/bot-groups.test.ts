import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountConfigV1 } from "@workspace/shared";
import { createGroupJev } from "./bot-groups.js";
import type { WorkerConfig } from "./config.js";

const withKey = { openRouterApiKey: "k" } as WorkerConfig;
const noKey = { openRouterApiKey: undefined } as unknown as WorkerConfig;
const account = (config: AccountConfigV1) => async () => config;

test("coordenação de grupos: desligada por padrão; liga pela conta ou pelo env; exige a chave", async () => {
	assert.equal(await createGroupJev(withKey, { loadConfig: account({ v: 1 }), env: {} }).enabled("u"), false);
	assert.equal(await createGroupJev(withKey, { loadConfig: account({ v: 1, groups: { jevCoordination: true } }), env: {} }).enabled("u"), true);
	assert.equal(await createGroupJev(withKey, { loadConfig: account({ v: 1 }), env: { GROUPS_JEV_COORDINATION: "on" } }).enabled("u"), true);
	assert.equal(await createGroupJev(withKey, { loadConfig: account({ v: 1, groups: { jevCoordination: false } }), env: { GROUPS_JEV_COORDINATION: "on" } }).enabled("u"), false);
	assert.equal(await createGroupJev(noKey, { loadConfig: account({ v: 1, groups: { jevCoordination: true } }), env: {} }).enabled("u"), false);
	const broken = createGroupJev(withKey, { loadConfig: async () => { throw new Error("db"); }, env: {} });
	assert.equal(await broken.enabled("u"), false);
});

test("ask devolve só as probabilidades e propaga erro (quem chama cai no fluxo base)", async () => {
	const ok = createGroupJev(withKey, { ask: (async () => ({ model: "m", answers: { a: 0.7 }, durationMs: 1 })) as never });
	assert.deepEqual(await ok.ask({ userId: "u", state: {}, questions: {} }), { a: 0.7 });
	const bad = createGroupJev(withKey, { ask: (async () => { throw new Error("timeout"); }) as never });
	await assert.rejects(() => bad.ask({ userId: "u", state: {}, questions: {} }));
});
