import assert from "node:assert/strict";
import test from "node:test";
import type { DevSessionEvent } from "@workspace/shared";

import { insertDevSessionCards } from "./cards";
import { parseDiffLines } from "./diff";
import {
	DEV_OUTPUT_CAP_CHARS,
	applyDevSessionEvent,
	devChangedFiles,
	devCurrentStep,
	devElapsedMs,
	devPillLabel,
	devRowStatus,
	devSessionCounters,
	devSessionTitle,
	devSetupLabel,
	devTimerLabel,
	formatElapsed,
	hydrateDevSession,
	stripAnsi,
	type DevSessionMap,
} from "./reducer";
import { applySubagentTrack } from "./subagent-track";

const S = "s1";

function run(events: Array<[DevSessionEvent, { at: number; seq?: number; runId?: string }?]>, start: DevSessionMap = {}) {
	let map = start;
	let at = 1_000;
	for (const [event, meta] of events) {
		map = applyDevSessionEvent(map, event, meta ?? { at });
		at += 1000;
	}
	return map;
}

const started: DevSessionEvent = { type: "shell_started", sessionId: S, callId: "c1", jobId: "j1", cmd: "pnpm test", cwd: "/w", startedAt: new Date(5_000).toISOString() };
const out = (chunk: string): DevSessionEvent => ({ type: "shell_output", sessionId: S, callId: "c1", jobId: "j1", chunk });

test("sequência de eventos monta status, comando, edição e tarefas", () => {
	const map = run([
		[{ type: "dev_session_status", sessionId: S, status: "CREATING", tier: "small", repo: "o/r", branch: "b" }],
		[{ type: "dev_setup_step", sessionId: S, step: "install", status: "running" }],
		[{ type: "dev_setup_step", sessionId: S, step: "install", status: "done", durationMs: 4000 }],
		[{ type: "dev_session_status", sessionId: S, status: "RUNNING", tier: "small" }],
		[started],
		[out("ok\n")],
		[{ type: "file_edit", sessionId: S, callId: "e1", path: "a.ts", diff: "+x", added: 1, removed: 0 }],
		[{ type: "todo_updated", sessionId: S, items: [{ id: "1", content: "t", status: "in_progress" }] }],
	]);
	const view = map[S]!;
	assert.equal(view.status, "RUNNING");
	assert.equal(view.repo, "o/r");
	assert.equal(view.setup.length, 1);
	assert.equal(view.setup[0]!.status, "done");
	assert.equal(view.commands[0]!.output, "ok\n");
	assert.equal(devCurrentStep(view), "pnpm test");
	assert.deepEqual(devSessionCounters(view), { commands: 1, files: 1, added: 1, removed: 0 });
	assert.deepEqual(view.timeline.map((t) => t.kind), ["setup", "command", "file"]);
	assert.equal(devSessionTitle(view), "o/r · b");
});

test("shell_done fecha o comando; encerrar a sessão congela o cronômetro", () => {
	const map = run([
		[{ type: "dev_session_status", sessionId: S, status: "RUNNING", tier: "small" }, { at: 1000 }],
		[started, { at: 2000 }],
		[{ type: "shell_done", sessionId: S, callId: "c1", jobId: "j1", exitCode: 1, durationMs: 3000, endedReason: "exit" }, { at: 3000 }],
		[{ type: "dev_session_status", sessionId: S, status: "STOPPED", tier: "small" }, { at: 61_000 }],
	]);
	const view = map[S]!;
	assert.equal(view.commands[0]!.status, "done");
	assert.equal(view.commands[0]!.exitCode, 1);
	assert.equal(devCurrentStep(view), null);
	assert.equal(devElapsedMs(view, 999_999), 60_000);
	assert.equal(devTimerLabel(view, 999_999), "Trabalhou por 1m00s");
});

test("comando em segundo plano não congela o tempo na espera de primeiro plano", () => {
	const map = run([
		[{ type: "dev_session_status", sessionId: S, status: "RUNNING", tier: "small" }, { at: 1000 }],
		[started, { at: 2000 }],
		[{ type: "shell_done", sessionId: S, callId: "c1", jobId: "j1", exitCode: null, durationMs: 1500, endedReason: "background_running" }, { at: 3500 }],
	]);
	const command = map[S]!.commands[0]!;
	assert.equal(command.status, "running");
	assert.equal(command.durationMs, undefined);
});

test("replay com seq repetido é idempotente (saída não duplica)", () => {
	const meta = (seq: number) => ({ at: 1000 * seq, seq, runId: "r1" });
	const events: Array<[DevSessionEvent, ReturnType<typeof meta>]> = [
		[started, meta(1)],
		[out("a"), meta(2)],
		[out("b"), meta(3)],
	];
	const once = run(events);
	const twice = run(events, once);
	assert.equal(twice[S]!.commands[0]!.output, "ab");
	assert.equal(twice, once);
	// run diferente com seq baixo não é descartado
	const other = applyDevSessionEvent(twice, out("c"), { at: 9, seq: 1, runId: "r2" });
	assert.equal(other[S]!.commands[0]!.output, "abc");
});

test("shell_started e file_edit repetidos não duplicam", () => {
	const edit: DevSessionEvent = { type: "file_edit", sessionId: S, callId: "e1", path: "a.ts", diff: "+x", added: 1, removed: 0 };
	const map = run([[started], [started], [edit], [edit]]);
	assert.equal(map[S]!.commands.length, 1);
	assert.equal(map[S]!.edits.length, 1);
	assert.equal(map[S]!.timeline.length, 2);
});

test("saída em memória é limitada aos últimos ~200 mil caracteres", () => {
	const chunk = "x".repeat(60_000);
	let map = run([[started]]);
	for (let i = 0; i < 6; i += 1) map = applyDevSessionEvent(map, out(chunk + (i === 5 ? "FIM" : "")), { at: 10 + i });
	const command = map[S]!.commands[0]!;
	assert.equal(command.output.length, DEV_OUTPUT_CAP_CHARS);
	assert.equal(command.truncated, true);
	assert.ok(command.output.endsWith("FIM"));
});

test("saída sem shell_started cria o comando em vez de perder o texto", () => {
	const map = run([[out("meio\n")]]);
	assert.equal(map[S]!.commands[0]!.output, "meio\n");
});

test("hidratação da API: sessão sem eventos, contadores e todos; eventos ao vivo mandam", () => {
	const api = {
		id: S,
		status: "STOPPED" as const,
		repo: "o/r",
		branch: "b",
		startedAt: new Date(10_000).toISOString(),
		lastActiveAt: new Date(70_000).toISOString(),
		todos: [{ id: "1", content: "t", status: "completed" as const }],
		stats: { commandsRun: 3, totalAdded: 9, totalRemoved: 2, filesChanged: [{ path: "a.ts", added: 9, removed: 2 }] },
	};
	const map = hydrateDevSession({}, api);
	const view = map[S]!;
	assert.equal(devTimerLabel(view, 0), "Trabalhou por 1m00s");
	assert.deepEqual(devSessionCounters(view), { commands: 3, files: 1, added: 9, removed: 2 });
	assert.equal(view.todos.length, 1);
	assert.equal(devChangedFiles(view)[0]!.path, "a.ts");
	// evento ao vivo depois da hidratação preserva os contadores da API como piso
	const live = applyDevSessionEvent(map, started, { at: 80_000 });
	assert.equal(devSessionCounters(live[S]!).commands, 3);
});

test("arquivos alterados agrupam por caminho e somam +/-", () => {
	const map = run([
		[{ type: "file_edit", sessionId: S, callId: "e1", path: "a.ts", diff: "+1", added: 2, removed: 1 }],
		[{ type: "file_edit", sessionId: S, callId: "e2", path: "a.ts", diff: "+2", added: 1, removed: 0 }],
	]);
	const files = devChangedFiles(map[S]!);
	assert.equal(files.length, 1);
	assert.deepEqual([files[0]!.added, files[0]!.removed, files[0]!.diffs.length], [3, 1, 2]);
});

test("utilitários: formatElapsed, stripAnsi, diff, cartões da conversa", () => {
	assert.equal(formatElapsed(12_000), "12s");
	assert.equal(formatElapsed(252_000), "4m12s");
	assert.equal(formatElapsed(3_720_000), "1h02m");
	assert.equal(stripAnsi("\u001b[31mred\u001b[0m ok\n10%\r20%\r30%\nfim"), "red ok\n30%\nfim");
	assert.deepEqual(
		parseDiffLines("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n z").map((l) => l.kind),
		["meta", "meta", "hunk", "remove", "add", "context"],
	);
	const thread = insertDevSessionCards(
		[
			{ id: "m1", kind: "user", text: "a", createdAt: new Date(1000).toISOString() },
			{ id: "m2", kind: "assistant", text: "b", createdAt: new Date(9000).toISOString() },
		],
		[{ id: S, startedAt: new Date(5000).toISOString() }],
	);
	assert.deepEqual(thread.map((m) => m.id), ["m1", "m2", `devsession-${S}`]);
	assert.equal(insertDevSessionCards(thread, [{ id: S, startedAt: new Date(5000).toISOString() }]).length, 3);
});

test("subagentes: início só na primeira vez, fim congela, ferramentas contam", () => {
	let map = applySubagentTrack({}, { type: "subagent_started", groupId: "g", taskIndex: 0 }, 100);
	map = applySubagentTrack(map, { type: "subagent_started", groupId: "g", taskIndex: 0 }, 900);
	map = applySubagentTrack(map, { type: "subagent_tool", groupId: "g", taskIndex: 0, name: "grep", ok: true }, 200);
	map = applySubagentTrack(map, { type: "subagent_tool", groupId: "g", taskIndex: 0, name: "grep", ok: false }, 300);
	map = applySubagentTrack(map, { type: "subagent_done", groupId: "g", taskIndex: 0 }, 400);
	map = applySubagentTrack(map, { type: "subagent_done", groupId: "g", taskIndex: 0 }, 800);
	const track = map["g:0"]!;
	assert.equal(track.startedAt, 100);
	assert.equal(track.endedAt, 400);
	assert.deepEqual(track.tools, [{ name: "grep", count: 2, failed: 1 }]);
});

test("sessão na fila mostra Na fila · aguardando recursos, sem cronômetro", () => {
	const map = run([[{ type: "dev_session_status", sessionId: S, status: "QUEUED", tier: "small" }]]);
	const view = map[S]!;
	assert.equal(devRowStatus(view, 9_000_000), "Na fila · aguardando recursos");
	assert.equal(devPillLabel(view, 9_000_000), "Na fila · aguardando recursos");
});

test("sessão parada ou expirada transforma comando em execução em interrompido/perdido (sem contador eterno)", () => {
	const stopped = run([
		[{ type: "dev_session_status", sessionId: S, status: "RUNNING", tier: "small" }, { at: 1_000 }],
		[started, { at: 5_000 }],
		[{ type: "shell_done", sessionId: S, callId: "c1", jobId: "j1", exitCode: null, durationMs: 1500, endedReason: "background_running" }, { at: 6_000 }],
		[{ type: "dev_session_status", sessionId: S, status: "STOPPED", tier: "small" }, { at: 65_000 }],
	]);
	const command = stopped[S]!.commands[0]!;
	assert.equal(command.status, "done");
	assert.equal(command.endedReason, "stopped");
	assert.equal(command.durationMs, 60_000);

	const lost = run([[started, { at: 5_000 }], [{ type: "dev_session_status", sessionId: S, status: "EXPIRED", tier: "small" }, { at: 9_000 }]]);
	assert.equal(lost[S]!.commands[0]!.endedReason, "lost");

	const closed = run([[started, { at: 5_000 }], [{ type: "shell_done", sessionId: S, callId: "c1", jobId: "j1", exitCode: null, durationMs: 90_000, endedReason: "lost" }, { at: 95_000 }]]);
	assert.equal(closed[S]!.commands[0]!.status, "done");
});

test("segundo shell_done do mesmo comando é ignorado (resultado final não é sobrescrito)", () => {
	const map = run([
		[{ type: "dev_session_status", sessionId: S, status: "RUNNING", tier: "small" }, { at: 1000 }],
		[started, { at: 2000 }],
		[{ type: "shell_done", sessionId: S, callId: "c1", jobId: "j1", exitCode: 0, durationMs: 3000, endedReason: "exit" }, { at: 5000 }],
		[{ type: "shell_done", sessionId: S, callId: "c1", jobId: "j1", exitCode: null, durationMs: 9000, endedReason: "lost" }, { at: 11_000 }],
	]);
	const command = map[S]!.commands[0]!;
	assert.equal(command.exitCode, 0);
	assert.equal(command.endedReason, "exit");
	assert.equal(command.durationMs, 3000);
});

test("passo de instalação guarda o estado do cache e o rótulo o mostra", () => {
	const map = run([
		[started],
		[{ type: "dev_setup_step", sessionId: S, step: "install", status: "running", cache: "hit" }],
		[{ type: "dev_setup_step", sessionId: S, step: "install", status: "done", durationMs: 2000 }],
	]);
	const step = map[S]!.setup.find((item) => item.step === "install")!;
	assert.equal(step.cache, "hit");
	assert.equal(devSetupLabel("install", step.cache, step.durationMs), "Instalando dependências · cache (2s)");
});

test("rótulos da instalação: hit, cache desatualizado, primeira vez e outros passos", () => {
	assert.equal(devSetupLabel("install"), "Instalando dependências");
	assert.equal(devSetupLabel("install", "hit"), "Instalando dependências · cache");
	assert.equal(devSetupLabel("install", "stale"), "Instalando dependências · cache desatualizado, reinstalando");
	assert.equal(devSetupLabel("install", "rebuild"), "Instalando dependências · cache desatualizado, reinstalando");
	assert.equal(devSetupLabel("install", "miss", 30_000), "Instalando dependências");
	assert.equal(devSetupLabel("clone", "hit"), "Clonando o repositório");
	assert.equal(devSetupLabel("detect"), "Detectando o ambiente");
	assert.equal(devSetupLabel("start"), "Iniciando o ambiente");
});

test("isBackgroundCommand: só background explícito/auto (>=30s) conta", async () => {
	const { isBackgroundCommand } = await import("./reducer");
	assert.equal(isBackgroundCommand({ durationMs: 0 }), false);
	assert.equal(isBackgroundCommand({ durationMs: 29_999 }), false);
	assert.equal(isBackgroundCommand({ durationMs: 30_000 }), true);
	assert.equal(isBackgroundCommand({ backgrounded: true }), true);
	assert.equal(isBackgroundCommand({}), false);
});
