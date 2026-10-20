import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutineRecord } from "@workspace/shared";
import type { Routine } from "../data";
import { groupRoutinesForPanel, RoutineGroupBlock, routineGroupSummary } from "./routine-group-block";
import { diffRoutineUpdatePayload, recordToUiRoutine, uiRoutineToPayload } from "./routine-map";

Object.assign(globalThis, { React });

const record = (patch: Partial<RoutineRecord> = {}): RoutineRecord => ({
	id: "r1",
	userId: "u1",
	botId: "b1",
	conversationId: null,
	name: "Resumo da semana",
	prompt: "Resuma a semana",
	model: "",
	enabled: true,
	triggerType: "cron",
	schedule: "0 8 * * 1",
	timezone: "America/Sao_Paulo",
	lastRunAt: null,
	createdAt: "2026-10-14T00:00:00.000Z",
	updatedAt: "2026-10-14T00:00:00.000Z",
	...patch,
});

const ui = (patch: Partial<RoutineRecord>): Routine => recordToUiRoutine(record(patch));

test("resumo do grupo: 'N de M ativas'", () => {
	assert.equal(routineGroupSummary(2, 3), "2 de 3 ativas");
	assert.equal(routineGroupSummary(1, 1), "1 de 1 ativa");
	assert.equal(routineGroupSummary(0, 0), "0 de 0 ativas");
});

test("agrupa na posição da primeira rotina e deixa as soltas como estão", () => {
	const groups = [{ id: "g1", name: "Vendas" }, { id: "g2", name: "Vazio" }];
	const items = groupRoutinesForPanel(
		[ui({ id: "a" }), ui({ id: "b", groupId: "g1" }), ui({ id: "c" }), ui({ id: "d", groupId: "g1" }), ui({ id: "e", groupId: "sumiu" })],
		groups,
	);
	assert.deepEqual(
		items.map((item) => (item.kind === "routine" ? item.routine.id : `${item.group.id}:${item.routines.map((r) => r.id).join(",")}`)),
		["a", "g1:b,d", "c", "e", "g2:"],
	);
});

test("bloco do grupo mostra nome, contagem e as ações", () => {
	const out = renderToStaticMarkup(
		<RoutineGroupBlock id="g1" name="Vendas" routines={[ui({ id: "b", groupId: "g1" }), ui({ id: "d", groupId: "g1", enabled: false })]}>
			<li>filho</li>
		</RoutineGroupBlock>,
	);
	assert.match(out, /data-routine-group="g1"/);
	assert.match(out, />Vendas</);
	assert.match(out, /1 de 2 ativas/);
	assert.match(out, /Pausar todas/);
	assert.match(out, /Mais ações do grupo Vendas/);
	assert.match(out, /max-md:hidden/);
});

test("com tudo pausado a ação vira 'Ativar todas'", () => {
	const out = renderToStaticMarkup(
		<RoutineGroupBlock id="g1" name="Vendas" routines={[ui({ id: "b", groupId: "g1", enabled: false })]}>
			{null}
		</RoutineGroupBlock>,
	);
	assert.match(out, /Ativar todas/);
	assert.doesNotMatch(out, /Pausar todas/);
});

test("groupId viaja no create e só no PATCH quando muda (null tira do grupo)", () => {
	const grouped = ui({ groupId: "g1" });
	assert.equal(grouped.groupId, "g1");
	assert.equal(uiRoutineToPayload(grouped).groupId, "g1");
	assert.equal("groupId" in uiRoutineToPayload(ui({})), false);
	const before = uiRoutineToPayload(grouped);
	assert.deepEqual(diffRoutineUpdatePayload(before, before), {});
	assert.deepEqual(diffRoutineUpdatePayload(uiRoutineToPayload({ ...grouped, groupId: null }), before), { groupId: null });
	assert.deepEqual(diffRoutineUpdatePayload(uiRoutineToPayload({ ...grouped, groupId: "g2" }), before), { groupId: "g2" });
});
