/**
 * Dois tiers da memória: notas do bot entram inteiras no prompt estável, sem depender
 * da pergunta; a relevância só complementa o que não coube. Puro (sem banco).
 * Runner: `tsx --test src/memory-tiers.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { entry } from "./memory-limits.helpers.js";
import { composeMemoryTiers } from "./memory-search.js";

const now = new Date("2026-10-15T12:00:00Z");
const view = (entries: ReturnType<typeof entry>[]) => ({ entries, usage: { used: 0, limit: 6000 } });
const hit = (e: ReturnType<typeof entry>) => ({ entry: e, score: 1, via: "text" as const });

test("nota sem relação com a pergunta continua no prompt estável", () => {
	const cnpj = entry("n1", "CNPJ da empresa: 12.345.678/0001-90");
	const tiers = composeMemoryTiers({ user: view([]), memory: view([cnpj, entry("n2", "Prefere respostas curtas")]) }, [], now);
	assert.match(tiers.stable ?? "", /12\.345\.678\/0001-90/);
	assert.match(tiers.stable ?? "", /respostas curtas/);
	assert.equal(tiers.volatile, null);
});

test("o estável não depende da pergunta (prefixo cacheável)", () => {
	const memory = view([entry("n1", "Fato A"), entry("n2", "Fato B")]);
	const semHit = composeMemoryTiers({ user: view([]), memory }, [], now);
	const comHit = composeMemoryTiers({ user: view([]), memory }, [hit(memory.entries[0]!)], now);
	assert.equal(semHit.stable, comHit.stable);
});

test("volátil traz só o que não coube no orçamento, sem repetir o que já está no estável", () => {
	const big = Array.from({ length: 30 }, (_, i) => entry(`m${i}`, `nota ${i} ${"z".repeat(300)}`, { importance: i === 29 ? 1 : i / 100 }));
	const tiers = composeMemoryTiers({ user: view([]), memory: view(big) }, [hit(big[29]!), hit(big[0]!)], now);
	assert.match(tiers.stable ?? "", /nota 29 /, "a mais importante cabe no estável");
	assert.doesNotMatch(tiers.stable ?? "", /nota 0 /, "a de menor importância ficou fora do orçamento");
	assert.match(tiers.volatile ?? "", /nota 0 /, "o que ficou de fora volta por relevância");
	assert.doesNotMatch(tiers.volatile ?? "", /nota 29 /, "sem repetir o que já está no estável");
});
