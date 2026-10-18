import assert from "node:assert/strict";
import test from "node:test";
import type { DevSessionEvent } from "@workspace/shared";

import {
	DEV_STATUS_LABEL,
	applyDevSessionEvent,
	devChangedFiles,
	devCurrentStep,
	devElapsedMs,
	devIsWorking,
	devPillLabel,
	devRowStatus,
	devSessionCounters,
	devStatusLabel,
	devStatusTone,
	devTimerLabel,
	netEditChange,
	withRunActivity,
	type DevSessionMap,
} from "./reducer";
import { sessionsNeedingSync } from "./session-sync";

const S = "s1";
const RUN = "r1";

function feed(events: Array<[DevSessionEvent, number]>, map: DevSessionMap = {}) {
	for (const [event, at] of events) map = applyDevSessionEvent(map, event, { at, runId: RUN });
	return map;
}

const status = (s: "RUNNING" | "STOPPED" | "EXPIRED" | "IDLE"): DevSessionEvent => ({ type: "dev_session_status", sessionId: S, status: s, tier: "small" });
const edit = (callId: string, diff: string, added: number, removed: number): DevSessionEvent => ({ type: "file_edit", sessionId: S, callId, path: "a.ts", diff, added, removed });

test("RUNNING com run ativo trabalha; fim do run sem comando vira Pronta com tempo congelado", () => {
	let map = feed([[status("RUNNING"), 0], [edit("e1", "-a\n+b", 1, 1), 363_000]]);
	map = withRunActivity(map, new Set([RUN]), 364_000);
	let view = map[S]!;
	assert.equal(devIsWorking(view), true);
	assert.equal(devStatusLabel(view), "Trabalhando");
	assert.equal(devTimerLabel(view, 400_000), "Trabalhando há 6m40s");

	map = withRunActivity(map, new Set(), 363_500);
	view = map[S]!;
	assert.equal(devIsWorking(view), false);
	assert.equal(devStatusLabel(view), "Pronta");
	assert.equal(devStatusTone(view), "idle");
	assert.equal(devCurrentStep(view), null);
	// congelado no fim do run, não corre com o relógio
	assert.equal(devTimerLabel(view, 9_999_999), "Trabalhou por 6m03s");
	assert.equal(devPillLabel(view, 9_999_999), "Pronta · 6m03s");
	assert.equal(devRowStatus(view, 9_999_999), "Pronta · 6m03s");
	assert.equal(devElapsedMs(view, 9_999_999), 363_500);
	// o resumo continua disponível
	assert.deepEqual(devSessionCounters(view), { commands: 0, files: 1, added: 1, removed: 1 });

	// novo run volta a trabalhar e descongela
	const again = withRunActivity(map, new Set([RUN]), 500_000);
	assert.equal(devIsWorking(again[S]!), true);
	assert.equal(again[S]!.endedAt, undefined);
	// sem mudança devolve o mesmo mapa
	assert.equal(withRunActivity(again, new Set([RUN]), 600_000), again);
});

test("comando em execução mantém trabalhando mesmo sem run; sessão recarregada sem run vira Pronta", () => {
	const started: DevSessionEvent = { type: "shell_started", sessionId: S, callId: "c1", jobId: "j1", cmd: "pnpm dev", cwd: "/w", startedAt: new Date(1000).toISOString() };
	let map = feed([[status("RUNNING"), 0], [started, 1000]]);
	map = withRunActivity(map, new Set(), 5000);
	assert.equal(devIsWorking(map[S]!), true);
	map = feed([[{ type: "shell_done", sessionId: S, callId: "c1", jobId: "j1", exitCode: 0, durationMs: 100, endedReason: "exit" }, 7000]], map);
	map = withRunActivity(map, new Set(), 8000);
	assert.equal(devStatusLabel(map[S]!), "Pronta");
	assert.equal(map[S]!.endedAt, 7000);
});

test("rótulos: STOPPED = Parada, EXPIRED = Expirada, IDLE = Concluída; tempo congela", () => {
	assert.equal(DEV_STATUS_LABEL.STOPPED, "Parada");
	assert.equal(DEV_STATUS_LABEL.EXPIRED, "Expirada");
	assert.equal(DEV_STATUS_LABEL.IDLE, "Concluída");
	const map = withRunActivity(feed([[status("RUNNING"), 0], [status("STOPPED"), 60_000]]), new Set(), 70_000);
	assert.equal(devRowStatus(map[S]!, 9_999_999), "Parada · 1m00s");
	assert.equal(devStatusLabel(feed([[status("EXPIRED"), 1]])[S]!), "Expirada");
});

test("view sem runActive (fora do store) segue o status do container", () => {
	const view = feed([[status("RUNNING"), 0]])[S]!;
	assert.equal(view.runActive, undefined);
	assert.equal(devIsWorking(view), true);
});

test("mudança líquida: reverter uma edição zera o saldo e some da lista", () => {
	const forward = edit("e1", "@@\n-const a = 1;\n+const a = 2;", 1, 1);
	const revert = edit("e2", "@@\n-const a = 2;\n+const a = 1;", 1, 1);
	assert.deepEqual(netEditChange([{ diff: "-const a = 1;\n+const a = 2;", added: 1, removed: 1 }]), { added: 1, removed: 1 });
	let map = feed([[forward, 1]]);
	assert.equal(devChangedFiles(map[S]!).length, 1);
	map = feed([[revert, 2]], map);
	assert.deepEqual(devChangedFiles(map[S]!), []);
	assert.deepEqual(devSessionCounters(map[S]!), { commands: 0, files: 0, added: 0, removed: 0 });
});

test("mudança líquida: edições independentes somam e reversão parcial cancela só o que voltou", () => {
	assert.deepEqual(
		netEditChange([
			{ diff: "+x\n+y", added: 2, removed: 0 },
			{ diff: "-x", added: 0, removed: 1 },
			{ diff: "+z", added: 1, removed: 0 },
		]),
		{ added: 2, removed: 0 },
	);
	// sem diff legível usa os contadores do evento
	assert.deepEqual(netEditChange([{ diff: "", added: 3, removed: 1 }]), { added: 3, removed: 1 });
});

test("sessionsNeedingSync: sessão desconhecida ou com status mudado fora do stream", () => {
	const listed = [
		{ id: "new", status: "RUNNING" as const, startedAt: "x" },
		{ id: "same", status: "RUNNING" as const, startedAt: "x" },
		{ id: "moved", status: "STOPPED" as const, startedAt: "x" },
	];
	const known = { same: { status: "RUNNING" as const }, moved: { status: "RUNNING" as const } };
	assert.deepEqual(sessionsNeedingSync(listed, known, false).map((s) => s.id), ["new", "moved"]);
	// com run ao vivo o stream é a fonte do status: só as desconhecidas
	assert.deepEqual(sessionsNeedingSync(listed, known, true).map((s) => s.id), ["new"]);
	assert.deepEqual(sessionsNeedingSync(listed, { ...known, moved: { status: "RUNNING" as const, runActive: true } }, false).map((s) => s.id), ["new"]);
});

test("tempo conta do início do run atual, não da criação da sessão reaproveitada", () => {
	const MIN = 60_000;
	// Sessão criada há 55min no run r0; run r1 começou há 12min.
	let map = applyDevSessionEvent({}, status("RUNNING"), { at: 0, runId: "r0" });
	map = withRunActivity(map, new Set(), 5 * MIN);
	map = applyDevSessionEvent(map, edit("e1", "-a\n+b", 1, 1), { at: 43 * MIN, runId: "r1" });
	map = withRunActivity(map, new Set(["r1"]), 43 * MIN + 1_000, new Map([["r1", 43 * MIN]]));
	const view = map[S]!;
	assert.equal(devIsWorking(view), true);
	assert.equal(devElapsedMs(view, 55 * MIN), 12 * MIN);
	assert.equal(devPillLabel(view, 55 * MIN), "Trabalhando · 12m00s");
	// Run termina: congela o último trecho (12min), não os 55min da sessão.
	const done = withRunActivity(map, new Set(), 55 * MIN)[S]!;
	assert.equal(devElapsedMs(done, 99 * MIN), 12 * MIN);
	assert.match(devTimerLabel(done, 99 * MIN), /Trabalhou por 12m00s/);
});

test("recarga sem relógio do run usa o primeiro evento do run atual", () => {
	const MIN = 60_000;
	let map = applyDevSessionEvent({}, status("RUNNING"), { at: 0, runId: "r0" });
	map = applyDevSessionEvent(map, edit("e1", "-a\n+b", 1, 1), { at: 40 * MIN, runId: "r1" });
	map = withRunActivity(map, new Set(["r1"]), 52 * MIN);
	assert.equal(devElapsedMs(map[S]!, 52 * MIN), 12 * MIN);
});

test("sessão preparando sem run ao vivo não zera o relógio ao parar", () => {
	let map = applyDevSessionEvent({}, { type: "dev_session_status", sessionId: S, status: "CREATING", tier: "small" }, { at: 1_000, runId: "r0" });
	map = withRunActivity(map, new Set(), 50_000_000);
	map = applyDevSessionEvent(map, status("STOPPED"), { at: 11_000, runId: "r0" });
	map = withRunActivity(map, new Set(), 50_000_001);
	assert.equal(devElapsedMs(map[S]!, 60_000_000), 10_000);
});
