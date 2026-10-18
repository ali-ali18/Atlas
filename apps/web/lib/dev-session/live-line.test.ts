import assert from "node:assert/strict";
import test from "node:test";
import type { DevSessionEvent } from "@workspace/shared";

import { devLiveLine, toolActivityDetail } from "./live-line";
import { applyDevSessionEvent, devCurrentStep, withRunActivity, type DevSessionMap } from "./reducer";

const S = "s1";
const RUN = "r1";
const NOW = 1_000_000;

function viewWith(events: DevSessionEvent[]) {
	let map: DevSessionMap = {};
	events.forEach((event, index) => {
		map = applyDevSessionEvent(map, event, { at: NOW - 100_000 + index * 1000, seq: index + 1, runId: RUN });
	});
	return withRunActivity(map, new Set([RUN]), NOW)[S]!;
}
const running: DevSessionEvent = { type: "dev_session_status", sessionId: S, status: "RUNNING", tier: "small" };

test("linha ao vivo: comando em execução com tempo", () => {
	const view = viewWith([running, { type: "shell_started", sessionId: S, callId: "c", jobId: "j", cmd: "pnpm test", cwd: "/w", startedAt: new Date(NOW - 72_000).toISOString() }]);
	assert.equal(devLiveLine({ view, activity: { phase: "thinking" }, now: NOW }), "Rodando pnpm test… 1m12s");
});

test("linha ao vivo: passo do ambiente, leitura, edição e pensando", () => {
	const setup = viewWith([{ type: "dev_session_status", sessionId: S, status: "CREATING", tier: "small" }, { type: "dev_setup_step", sessionId: S, step: "clone", status: "running" }]);
	assert.equal(devLiveLine({ view: setup, activity: { phase: "thinking" }, now: NOW }), "Clonando o repositório…");
	const view = viewWith([running]);
	assert.equal(devLiveLine({ view, activity: { phase: "tool", tool: "read_file", detail: "apps/web/src/app.ts" }, now: NOW }), "Lendo src/app.ts");
	assert.equal(devLiveLine({ view, activity: { phase: "tool", tool: "edit_file", detail: "a/b.ts" }, now: NOW }), "Editando a/b.ts");
	assert.equal(devLiveLine({ view, activity: { phase: "thinking" }, now: NOW }), "Pensando…");
});

test("linha ao vivo: edições do trecho viram contagem; aprovação pendente vence", () => {
	const edit = (callId: string, path: string): DevSessionEvent => ({ type: "file_edit", sessionId: S, callId, path, diff: "+a", added: 1, removed: 0 });
	const view = viewWith([running, edit("e1", "a.ts"), edit("e2", "b.ts")]);
	assert.equal(devLiveLine({ view, activity: { phase: "tool", tool: "edit_file", detail: "c.ts" }, now: NOW }), "Editando 3 arquivos");
	assert.equal(devLiveLine({ view, activity: { phase: "thinking" }, pendingApproval: true, now: NOW }), "Aguardando sua aprovação");
});

test("sem sessão de código não há linha especial; detalhe da ferramenta", () => {
	assert.equal(devLiveLine({ activity: { phase: "thinking" }, now: NOW }), null);
	assert.equal(toolActivityDetail("shell", { cmd: "ls -la" }), "ls -la");
	assert.equal(toolActivityDetail("read_file", { path: "x.ts" }), "x.ts");
	assert.equal(toolActivityDetail("web_search", { q: "x" }), undefined);
});

test("linha ao vivo: segredos do comando (running e tool) são redigidos antes de aparecer", () => {
	const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	const view = viewWith([running, { type: "shell_started", sessionId: S, callId: "c", jobId: "j", cmd: `curl -H "Authorization: Bearer abcdefghijklmnop1234" ${token}`, cwd: "/w", startedAt: new Date(NOW - 5000).toISOString() }]);
	const line = devLiveLine({ view, activity: { phase: "thinking" }, now: NOW }) ?? "";
	assert.ok(!line.includes(token) && !line.includes("abcdefghijklmnop1234"), line);
	const idle = viewWith([running]);
	const tool = devLiveLine({ view: idle, activity: { phase: "tool", tool: "shell", detail: `git push https://x:${token}` }, now: NOW }) ?? "";
	assert.ok(!tool.includes(token), tool);
	assert.ok(!(devCurrentStep(view) ?? "").includes(token));
});
