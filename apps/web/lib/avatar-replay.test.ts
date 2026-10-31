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
	assert.ok((time.get("thinking") ?? 0) + (time.get("working") ?? 0) < total * 0.6, `pensando/trabalhando demais: ${JSON.stringify([...time])}`);
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

// Etapa 2: o modelo demora gerando os argumentos de uma tool grande (arquivo, código). Sem o aviso `tool_intent`
// o avatar fica em "pensando" até o `tool_call`; com ele, mostra a família da ferramenta desde que o nome chega.
const GEN_TOOLS: Array<{ name: string; run: number; gen: number }> = [
	{ name: "web_search", run: 1800, gen: 3500 },
	{ name: "write_file", run: 200, gen: 14000 },
	{ name: "edit_file", run: 200, gen: 6000 },
	{ name: "run_code", run: 2500, gen: 10000 },
	{ name: "read_file", run: 150, gen: 3500 },
];
/** Nome da tool chega ~1 s depois de o modelo começar a gerar (o resto é geração de argumentos). */
const NAME_LATENCY_MS = 1000;

function genTimeline(withIntent: boolean): { timeline: Array<[number, AgentActivity]>; end: number } {
	const timeline: Array<[number, AgentActivity]> = [[0, { phase: "thinking" }]];
	let t = 0;
	GEN_TOOLS.forEach(({ name, run, gen }, step) => {
		if (withIntent) timeline.push([t + Math.min(NAME_LATENCY_MS, gen), { phase: "tool", tool: name, arriving: true }]);
		t += gen;
		timeline.push([t, tool(name, step)]);
		t += run;
		timeline.push([t, { phase: "thinking" }]);
	});
	t += LLM_PAUSE_MS;
	timeline.push([t, { phase: "writing" }]);
	return { timeline, end: t + 3500 };
}

function replayGen(id: string, withIntent: boolean) {
	const { timeline, end } = genTimeline(withIntent);
	const base = 9_000_000;
	const time = new Map<string, number>();
	setBotWorking(id, true);
	beginBotRun(id, base);
	let index = 0;
	let activity: AgentActivity = { phase: "idle" };
	for (let t = 0; t < end; t += 50) {
		while (index < timeline.length && (timeline[index] as [number, AgentActivity])[0] <= t) activity = (timeline[index++] as [number, AgentActivity])[1];
		setBotActivity(id, activity, { status: "queued" }, base + t);
		refreshBotAvatar(id, base + t);
		const state = botAvatarSignal(id).state;
		time.set(state, (time.get(state) ?? 0) + 50);
	}
	setBotWorking(id, false);
	endBotRun(id, "ok", base + end);
	const total = [...time.values()].reduce((a, b) => a + b, 0);
	return { time, total, thinkingPct: Math.round(((time.get("thinking") ?? 0) / total) * 100) };
}

test("geração longa de argumentos: com tool_intent o avatar sai de 'pensando' pelo nome da tool", () => {
	const before = replayGen("gen-before", false);
	const after = replayGen("gen-after", true);
	console.log(`pensando (geração de argumentos grandes): antes ${before.thinkingPct}% -> depois ${after.thinkingPct}%`);
	console.log(`antes ${JSON.stringify([...before.time])}\ndepois ${JSON.stringify([...after.time])}`);
	assert.ok(after.thinkingPct < before.thinkingPct - 20, `esperava queda grande: ${before.thinkingPct}% -> ${after.thinkingPct}%`);
	assert.ok((after.time.get("coding") ?? 0) > (before.time.get("coding") ?? 0), "Programando aparece enquanto o arquivo é gerado");
	assert.ok((after.time.get("running") ?? 0) > (before.time.get("running") ?? 0), "Rodando aparece enquanto o código é gerado");
	assert.equal(after.time.get("waiting") ?? 0, 0);
});
