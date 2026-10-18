/**
 * Contrato da migration do log de eventos (sem banco): cada tabela de estado tem gatilho DEFERRED que publica
 * pelo publicador único, e o publicador usa o contador por usuário. Quebrar isso traz de volta os "cards
 * que se perdem" (evento antes do commit) ou o seq fora de ordem.
 * Runner: `tsx --test src/user-events.migration.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sql = readFileSync(new URL("../prisma/migrations/20261103120000_user_events/migration.sql", import.meta.url), "utf8");

test("todo gatilho de evento é constraint trigger adiado (roda no commit)", () => {
	const triggers = [...sql.matchAll(/CREATE (CONSTRAINT )?TRIGGER (\w+)([\s\S]*?);/g)];
	assert.ok(triggers.length >= 9);
	for (const [, constraint, name, body] of triggers) {
		assert.ok(constraint, `${name} precisa ser CONSTRAINT TRIGGER`);
		assert.match(body!, /DEFERRABLE INITIALLY DEFERRED/, `${name} precisa ser adiado`);
		assert.match(body!, /FOR EACH ROW/);
	}
});

test("os estados que o app mostra têm gatilho", () => {
	for (const table of ["conversation_messages", "agent_runs", "conversation_reads", "bots", "dev_sessions", "orchestrator_reflections"]) {
		assert.match(sql, new RegExp(`ON ${table}[^_a-z]`), `sem gatilho em ${table}`);
	}
});

test("run só dispara em mudança de status; falha do gatilho nunca derruba a escrita", () => {
	assert.match(sql, /AFTER UPDATE OF status ON agent_runs/);
	const functions = sql.split("CREATE OR REPLACE FUNCTION").filter((part) => part.includes("RETURNS TRIGGER"));
	assert.ok(functions.length >= 6);
	for (const fn of functions) assert.match(fn, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
});

test("publicador: contador por usuário com upsert (serializa e não deixa buracos)", () => {
	assert.match(sql, /INSERT INTO user_event_counters[\s\S]*ON CONFLICT \("userId"\) DO UPDATE SET seq = user_event_counters\.seq \+ 1[\s\S]*RETURNING seq INTO v_seq/);
	assert.match(sql, /CREATE UNIQUE INDEX "user_events_userId_seq_key"/);
});
