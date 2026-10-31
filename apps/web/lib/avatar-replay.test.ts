// Repete um run realista (status "queued" gravado no começo e nunca trocado, como no servidor de verdade)
// pelo bus + governador reais e mede o tempo em cada estado do avatar.
import assert from "node:assert/strict";
import test from "node:test";

import { beginBotRun, botAvatarSignal, endBotRun, refreshBotAvatar, setBotActivity, setBotWorking } from "./bot-activity";
import type { AgentActivity } from "./working-status";

const tool = (name: string, step: number): AgentActivity => ({ phase: "tool", tool: name, step, maxSteps: 8 });

/**
 * Run realista: o modelo leva ~3,5 s para decidir entre uma ferramenta e outra e as ferramentas
 * duram de 80 a 500 ms (leitura, edição, shell curto). É onde o avatar vivia "pensando".
 */
const LLM_PAUSE_MS = 3500;
const TOOLS: Array<[string, number]> = [["navigate", 400], ["read_file", 150], ["edit_file", 200], ["shell", 500], ["web_search", 300], ["read_file", 80]];

/** [instante (ms), atividade] — o que o use-atlas-chat publica num run com várias ferramentas. */
function buildTimeline(pause: number): { timeline: Array<[number, AgentActivity]>; end: number } {
	const timeline: Array<[number, AgentActivity]> = [[0, { phase: "thinking" }]];
	let t = 0;
	TOOLS.forEach(([name, duration], step) => {
		t += pause;
		timeline.push([t, tool(name, step)]);
		t += duration;
		timeline.push([t, { phase: "thinking" }]);
	});
	t += pause;
	timeline.push([t, { phase: "writing" }]);
	return { timeline, end: t + 3500 };
}
const { timeline: TIMELINE, end: END } = buildTimeline(LLM_PAUSE_MS);

function replay(id: string, base: number, approval?: [number, number]) {
	const time = new Map<string, number>();
	setBotWorking(id, true);
	beginBotRun(id, base);
	let index = 0;
	let activity: AgentActivity = { phase: "idle" };
	for (let t = 0; t < END; t += 100) {
		while (index < TIMELINE.length && (TIMELINE[index] as [number, AgentActivity])[0] <= t) activity = (TIMELINE[index++] as [number, AgentActivity])[1];
		const pending = approval ? t >= approval[0] && t < approval[1] : false;
		// `queued`: o app o grava ao criar o run e o servidor não manda "running" (ver run-stream.ts / agent-run.ts)
		setBotActivity(id, activity, { status: "queued", pendingApproval: pending }, base + t);
		refreshBotAvatar(id, base + t);
		const state = botAvatarSignal(id).state;
		time.set(state, (time.get(state) ?? 0) + 100);
	}
	setBotWorking(id, false);
	endBotRun(id, "ok", base + END);
	return time;
}

test("run normal com status 'queued' o tempo todo: o avatar nunca fica em espera", () => {
	const time = replay("rp1", Date.now());
	assert.equal(time.get("waiting") ?? 0, 0, JSON.stringify([...time]));
	for (const state of ["thinking", "searching", "reading", "coding", "running", "streaming"]) assert.ok((time.get(state) ?? 0) > 0, `${state} nunca apareceu: ${JSON.stringify([...time])}`);
	const total = [...time.values()].reduce((a, b) => a + b, 0);
	// antes: ~66% do run em "pensando", mesmo com ferramenta rodando de verdade
	assert.ok((time.get("thinking") ?? 0) <= total * 0.5, `pensando demais: ${JSON.stringify([...time])}`);
	// ferramentas curtas (< 3 s) nunca acendem o anel de progresso
	assert.equal(time.get("progress") ?? 0, 0, JSON.stringify([...time]));
});

test("espera só enquanto há aprovação pendente (3 s de 17 s) e entra na hora", () => {
	const time = replay("rp2", Date.now(), [6000, 9000]);
	const waiting = time.get("waiting") ?? 0;
	assert.ok(waiting >= 2900 && waiting <= 4300, `espera fora da janela: ${waiting} ${JSON.stringify([...time])}`);
});

// Rótulo do indicador no mesmo run: "está começando" só até o primeiro sinal de vida.
test("rótulo e avatar: 'queued' vira 'running' no primeiro evento e o rótulo acompanha a atividade", async () => {
	const { runStatusOnProgress, workingStatusLabel } = await import("./working-status");
	let status: string | null = "queued";
	const labels: string[] = [];
	const first = workingStatusLabel("Jujubinha", { phase: "idle" }, { status });
	assert.match(first, /começando/);
	let activity: AgentActivity = { phase: "idle" };
	let index = 0;
	for (let t = 0; t < END; t += 100) {
		while (index < TIMELINE.length && (TIMELINE[index] as [number, AgentActivity])[0] <= t) {
			activity = (TIMELINE[index++] as [number, AgentActivity])[1];
			status = runStatusOnProgress(status); // o use-atlas-chat promove no evento `run`, no texto e na ferramenta
		}
		labels.push(workingStatusLabel("Jujubinha", activity, { status }));
	}
	assert.equal(status, "running");
	assert.ok(labels.every((l) => !/começando/.test(l)), "o rótulo não pode voltar a 'começando'");
	assert.ok(labels.some((l) => /pesquisando/.test(l)) && labels.some((l) => /escrevendo/.test(l)));
});

test("runStatusOnProgress só promove 'queued'; retrying, waiting_*, paused e pausing continuam como estão", async () => {
	const { runStatusOnProgress, workingStatusLabel } = await import("./working-status");
	assert.equal(runStatusOnProgress("queued"), "running");
	for (const s of ["running", "retrying", "waiting_user", "waiting_external", "paused", "pausing", "stale", null]) assert.equal(runStatusOnProgress(s), s);
	// e eles ainda mandam no texto
	assert.match(workingStatusLabel("Atlas", { phase: "thinking" }, { status: runStatusOnProgress("waiting_user") }), /esperando você|aguardando|espera/i);
});
