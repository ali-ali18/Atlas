import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROACTIVE_SETTINGS, REFLECTION_RECHECK_PREFIX, buildFollowupPrompt } from "@workspace/shared";
import { runToolFilter } from "./run-tool-filter.js";

const mcp = {
	toolset: {
		entries: new Map([
			["mcp__erp__listar_pedidos", { readOnly: true }],
			["mcp__erp__criar_pedido", { readOnly: false }],
		]),
	},
};
const now = new Date("2026-11-03T12:00:00Z");
const followup = (kind: "check" | "reminder") =>
	buildFollowupPrompt({ note: "Ver no ERP se o pedido do cliente X chegou", kind, requestedFor: now, settings: DEFAULT_PROACTIVE_SETTINGS, now, recentMessages: [] });

test("follow-up check (replay do objetivo real): escrita nativa e de conector somem, leitura e rearmar ficam", () => {
	const filter = runToolFilter({ origin: "proactive", conversationId: "conv-1", objective: followup("check") }, mcp);
	assert.ok(filter, "o check precisa de filtro");
	for (const name of ["create_file", "email_send", "page_create", "propose_routine", "memory", "run_code", "cancel_followup", "mcp__erp__criar_pedido"]) {
		assert.equal(filter(name), false, name);
	}
	for (const name of ["web_search", "mcp_tool_search", "mcp__erp__listar_pedidos", "list_followups", "schedule_followup", "reschedule_followup"]) {
		assert.equal(filter(name), true, name);
	}
});

test("lembrete (reminder) e chat comum continuam sem filtro", () => {
	assert.equal(runToolFilter({ origin: "proactive", conversationId: "conv-1", objective: followup("reminder") }, mcp), undefined);
	assert.equal(runToolFilter({ origin: "chat", conversationId: "conv-1", objective: followup("check") }, mcp), undefined);
	assert.equal(runToolFilter({ origin: "chat", conversationId: "conv-1", objective: "oi" }, mcp), undefined);
});

test("brief e verificação diária mantêm os filtros de antes", () => {
	const brief = runToolFilter({ origin: "routine", conversationId: null, objective: "[EXECUÇÃO DE ROTINA] brief" }, mcp);
	assert.ok(brief);
	assert.equal(brief("mcp__erp__criar_pedido"), false);
	assert.equal(brief("mcp__erp__listar_pedidos"), true);
	const recheck = runToolFilter({ origin: "proactive", conversationId: null, objective: `${REFLECTION_RECHECK_PREFIX} x` }, mcp);
	assert.ok(recheck);
	assert.equal(recheck("schedule_followup"), false);
	assert.equal(recheck("web_search"), true);
});
