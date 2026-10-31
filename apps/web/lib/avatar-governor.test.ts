import assert from "node:assert/strict";
import test from "node:test";

import { avatarStateForActivity } from "./avatar-activity";
import { GOVERNOR_TUNING, createAvatarGovernor } from "./avatar-governor";
import type { AgentActivity } from "./working-status";

const T = GOVERNOR_TUNING;
const desired = (activity: AgentActivity) => avatarStateForActivity(activity);
const tool = (name: string, step?: number, maxSteps?: number): AgentActivity => ({ phase: "tool", tool: name, step, maxSteps });

test("começa em idle e o primeiro estado de trabalho entra na hora", () => {
	const g = createAvatarGovernor();
	assert.equal(g.signal(0).state, "idle");
	g.push(desired({ phase: "thinking" }), 100);
	assert.equal(g.signal(100).state, "thinking");
});

test("repouso e trabalho genérico não seguram ninguém: o primeiro estado de atividade entra na hora", () => {
	const g = createAvatarGovernor();
	g.push({ state: "working", step: null, progress: null }, 0);
	assert.equal(g.signal(0).state, "working");
	g.push(desired({ phase: "thinking" }), 50);
	assert.equal(g.signal(50).state, "thinking");
	g.push({ state: "idle", step: null, progress: null }, 10_000);
	g.signal(10_000);
	g.push(desired({ phase: "writing" }), 10_100);
	assert.equal(g.signal(10_100).state, "streaming");
});

test("begin() esquece a comemoração do run anterior", () => {
	const g = createAvatarGovernor();
	g.push(desired({ phase: "writing" }), 0);
	g.signal(0);
	g.push({ state: "idle", step: null, progress: null }, 3000);
	g.event("finished", 3000);
	assert.equal(g.signal(3000).state, "finished");
	g.begin();
	g.push(desired({ phase: "thinking" }), 3100);
	assert.equal(g.signal(3100).state, "thinking");
});

test("troca rápida de ferramenta: só a última vale e só depois da permanência mínima", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate")), 0);
	assert.equal(g.signal(0).state, "searching");
	// 3 trocas em 300 ms: nada muda ainda
	g.push(desired(tool("read_file")), 100);
	assert.equal(g.signal(100).state, "searching");
	g.push(desired(tool("edit_file")), 200);
	g.push(desired(tool("shell")), 300);
	assert.equal(g.signal(300).state, "searching");
	assert.equal(g.nextChangeMs(300), T.minDwellMs - 300);
	// vence a permanência: vai direto para a última (reading/coding nunca apareceram)
	assert.equal(g.signal(T.minDwellMs - 1).state, "searching");
	assert.equal(g.signal(T.minDwellMs).state, "running");
});

test("trocar e voltar dentro da permanência não muda nada (sem pisca-pisca)", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate")), 0);
	g.signal(0);
	g.push(desired(tool("read_file")), 400);
	g.signal(400);
	g.push(desired(tool("navigate")), 800);
	assert.equal(g.signal(800).state, "searching");
	assert.equal(g.signal(5000).state, "searching");
	assert.equal(g.nextChangeMs(5000), null);
});

test("depois da permanência a troca é imediata", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate")), 0);
	g.signal(0);
	g.push(desired(tool("edit_file")), 5000);
	assert.equal(g.signal(5000).state, "coding");
});

test("o anel nunca vem antes nem por cima do começo da ferramenta: só aparece se o mesmo passo durar mais de ~3 s", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 8)), 0);
	// a ferramenta aparece na hora, com a fração já disponível, mas o anel espera
	assert.deepEqual(g.signal(0), { state: "reading", progress: 1 / 8 });
	assert.equal(g.signal(T.progressAfterMs - 1).state, "reading");
	assert.equal(g.nextChangeMs(1000), T.progressAfterMs - 1000);
	// passou do limiar: o anel aparece com a fração do passo e depois volta à ferramenta
	const s = g.signal(T.progressAfterMs);
	assert.equal(s.state, "progress");
	assert.equal(s.progress, 1 / 8);
	assert.equal(g.signal(T.progressAfterMs + T.progressFlashMs).state, "reading");
	// mesmo passo de novo (outro render): sem novo anel
	g.push(desired(tool("read_file", 0, 8)), 9000);
	assert.equal(g.signal(9000).state, "reading");
});

test("ferramenta curta (resultado antes de ~3 s) não acende anel nenhum", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate", 0, 8)), 0);
	g.signal(0);
	g.push(desired({ phase: "thinking" }), 800);
	for (let t = 800; t < 6000; t += 100) assert.notEqual(g.signal(t).state, "progress", `t=${t}`);
});

test("passo longo seguido de outro passo longo: um anel por intervalo, com a fração do passo mais recente", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate", 0, 8)), 0);
	g.signal(0);
	assert.equal(g.signal(T.progressAfterMs).state, "progress");
	assert.equal(g.signal(T.progressAfterMs + T.progressFlashMs).state, "searching");
	// passos 1 e 2 chegam logo depois do anel; o 1 é curto e o 2 dura: o anel do 2 espera o intervalo e aparece
	g.push(desired(tool("read_file", 1, 8)), 4200);
	g.signal(4200);
	g.push(desired(tool("edit_file", 2, 8)), 5600);
	let ringAt = -1;
	for (let t = 5600; t < 12_000 && ringAt < 0; t += 50) if (g.signal(t).state === "progress") ringAt = t;
	assert.equal(ringAt, 5600 + T.progressAfterMs, "anel do passo longo, depois do limiar e do intervalo");
	for (let t = ringAt; t <= ringAt + T.progressFlashMs; t += 50) g.signal(t);
	// passo seguinte começa depois do intervalo e dura mais que o limiar
	const start = ringAt + T.progressFlashMs + T.progressCooldownMs + 500;
	g.push(desired(tool("shell", 3, 8)), start);
	assert.equal(g.signal(start).state, "running");
	const s = g.signal(start + T.progressAfterMs);
	assert.equal(s.state, "progress");
	assert.equal(s.progress, 4 / 8);
});

test("sem total de passos não há anel", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 2)), 0);
	assert.equal(g.signal(0).state, "reading");
	assert.equal(g.signal(0).progress, null);
});

test("falha de ferramenta: cara de erro na hora, ignora a permanência, e volta ao que fazia", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("shell")), 0);
	g.signal(0);
	g.event("failed", 200);
	assert.equal(g.signal(200).state, "failed");
	g.push(desired({ phase: "thinking" }), 300);
	assert.equal(g.signal(300).state, "failed");
	assert.equal(g.nextChangeMs(300), 200 + T.failedMs - 300);
	assert.equal(g.signal(200 + T.failedMs).state, "thinking");
});

test("fim do run: comemora e só depois volta ao repouso", () => {
	const g = createAvatarGovernor();
	g.push(desired({ phase: "writing" }), 0);
	g.signal(0);
	g.push({ state: "idle", step: null, progress: null }, 3000);
	g.event("finished", 3000);
	assert.equal(g.signal(3000).state, "finished");
	assert.equal(g.signal(3000 + T.finishedMs - 1).state, "finished");
	assert.equal(g.signal(3000 + T.finishedMs).state, "idle");
});

test("novo run depois do fim reinicia o passo (o anel volta a valer no passo 0)", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 4)), 0);
	g.signal(T.progressAfterMs);
	g.push({ state: "idle", step: null, progress: null }, 10_000);
	g.signal(10_000);
	g.push(desired(tool("read_file", 0, 4)), 20_000);
	assert.equal(g.signal(20_000).state, "reading");
	assert.equal(g.signal(20_000 + T.progressAfterMs).state, "progress");
});

test("determinístico: mesma sequência, mesmo resultado", () => {
	const run = () => {
		const g = createAvatarGovernor();
		const out: string[] = [];
		const steps: [number, AgentActivity][] = [
			[0, { phase: "thinking" }],
			[500, tool("navigate", 0, 5)],
			[900, tool("read_file", 1, 5)],
			[3000, { phase: "writing" }],
		];
		for (const [t, a] of steps) {
			g.push(desired(a), t);
			out.push(g.signal(t).state);
		}
		for (let t = 3000; t < 8000; t += 250) out.push(g.signal(t).state);
		return out;
	};
	assert.deepEqual(run(), run());
});

test("depois do resultado a família da ferramenta fica na tela e só então volta a pensando", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 8)), 0);
	assert.equal(g.signal(0).state, "reading");
	g.push(desired({ phase: "thinking" }), 150); // ferramenta de 150 ms
	assert.equal(g.signal(150).state, "reading");
	assert.equal(g.nextChangeMs(150), T.toolLingerMs);
	assert.equal(g.signal(150 + T.toolLingerMs - 1).state, "reading");
	assert.equal(g.signal(150 + T.toolLingerMs).state, "thinking");
});

test("outra ferramenta durante a permanência troca direto, sem passar por pensando", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file", 0, 8)), 0);
	g.signal(0);
	g.push(desired({ phase: "thinking" }), 200);
	g.push(desired(tool("shell", 1, 8)), 1800);
	assert.equal(g.signal(1800).state, "running");
	// e a permanência da primeira não volta depois: pensando de verdade só 2,5 s depois do 2º resultado
	g.push(desired({ phase: "thinking" }), 2400);
	assert.equal(g.signal(2400 + T.toolLingerMs - 1).state, "running");
	assert.equal(g.signal(2400 + T.toolLingerMs).state, "thinking");
});

test("escrever a resposta ou terminar durante a permanência corta a permanência", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("web_search", 0, 8)), 0);
	g.signal(0);
	g.push(desired({ phase: "thinking" }), 2000);
	g.push(desired({ phase: "writing" }), 2500);
	assert.equal(g.signal(2500).state, "streaming");
	assert.equal(g.signal(2500 + T.toolLingerMs).state, "streaming");
});

test("ferramenta que falhou não segura a família: cara de erro e depois pensando", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("shell", 0, 8)), 0);
	g.signal(0);
	g.event("failed", 300);
	g.push(desired({ phase: "thinking", toolFailed: true }), 300);
	assert.equal(g.signal(300).state, "failed");
	assert.equal(g.signal(300 + T.failedMs).state, "thinking");
});

test("pensando não segura a ferramenta seguinte: ela entra na hora", () => {
	const g = createAvatarGovernor();
	g.push(desired({ phase: "thinking" }), 0);
	g.signal(0);
	g.push(desired(tool("navigate", 0, 8)), 200);
	assert.equal(g.signal(200).state, "searching");
});

test("anel que perde o sentido (a ferramenta acabou antes de ~3 s) não aparece depois", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("edit_file", 1, 8)), 0);
	g.signal(0);
	g.push(desired({ phase: "thinking" }), 400);
	g.signal(400);
	for (let t = 400; t < 9000; t += 100) assert.notEqual(g.signal(t).state, "progress", `t=${t}`);
});

test("pedir o usuário (waiting) entra na hora, mesmo dentro da permanência do estado anterior", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("read_file")), 0);
	g.signal(0);
	g.push({ state: "waiting", step: null, progress: null }, 200);
	assert.equal(g.signal(200).state, "waiting");
});

test("passo longo que começa logo depois de um anel ainda ganha o anel (cooldown vale na hora de mostrar)", () => {
	const g = createAvatarGovernor();
	g.push(desired(tool("navigate", 0, 8)), 0);
	g.signal(0);
	assert.equal(g.signal(3500).state, "progress"); // passo A de 3,5 s
	g.push(desired(tool("read_file", 1, 8)), 3600); // passo B começa dentro do cooldown
	g.signal(4600); // o anel de A acabou
	assert.equal(g.signal(3600 + T.progressAfterMs).state, "reading", "cooldown ainda não passou");
	assert.ok(g.nextChangeMs(7000)! > 0);
	assert.equal(g.signal(3500 + T.progressCooldownMs).state, "progress");
	assert.equal(g.signal(60_000).state, "reading");
});
