/**
 * Ligação do worker: o toolset de conector do run só é montado "sem humano" (somente leitura) para as origens de
 * `isReadOnlyConnectorOrigin`. Tirar a origem da lista (runtime) ou o fio do worker quebra este teste.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/connector-read-only-origin.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isReadOnlyConnectorOrigin } from "@workspace/agent-runtime";

test("o runtime marca rotina, webhook, proativo, e-mail e bot como somente leitura no conector", () => {
	for (const origin of ["routine", "webhook", "proactive", "email", "bot"]) assert.equal(isReadOnlyConnectorOrigin(origin), true, origin);
	for (const origin of ["chat", "subagent"]) assert.equal(isReadOnlyConnectorOrigin(origin), false, origin);
});

test("o processador do run passa essa regra para o loadMcpRuntime (sem lista própria)", () => {
	const source = readFileSync(new URL("./processors/agent-run.ts", import.meta.url), "utf8");
	assert.match(source, /const unattended = isReadOnlyConnectorOrigin\(run\.origin\);/);
	assert.match(source, /loadMcpRuntime\(\{[^}]*\bunattended\b/);
});
