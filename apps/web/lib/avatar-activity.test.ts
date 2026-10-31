import assert from "node:assert/strict";
import test from "node:test";

import { avatarStateForActivity, stepProgress } from "./avatar-activity";
import { toolKind, type AgentActivity } from "./working-status";

const tool = (name: string, extra: Partial<Extract<AgentActivity, { phase: "tool" }>> = {}): AgentActivity => ({
	phase: "tool",
	tool: name,
	...extra,
});
const stateOf = (activity: AgentActivity, ctx = {}) => avatarStateForActivity(activity, ctx).state;

test("pensando e escrevendo viram thinking e streaming", () => {
	assert.equal(stateOf({ phase: "thinking" }), "thinking");
	assert.equal(stateOf({ phase: "writing" }), "streaming");
});

test("revisando a resposta vira thinking (o rascunho some do chat; digitar mentiria)", () => {
	assert.equal(stateOf({ phase: "revising" }), "thinking");
});

test("sem detalhe (rotina, outro aparelho) o avatar faz os gestos genéricos de trabalho", () => {
	assert.equal(stateOf({ phase: "idle" }), "working");
});

test("ferramentas por família: pesquisa, leitura, código, execução, controle", () => {
	const cases: [string, string][] = [
		["navigate", "searching"],
		["browser_text", "searching"],
		["web_search", "searching"],
		["web_extract", "searching"],
		["firecrawl_scrape", "searching"],
		["read_file", "reading"],
		["memory", "reading"],
		["screenshot", "reading"],
		["attachment_read", "reading"],
		["list_files", "reading"],
		["write_file", "coding"],
		["edit_file", "coding"],
		["create_file", "coding"],
		["shell", "running"],
		["run_code", "running"],
		["sandbox_shell", "running"],
		["click", "controlling"],
		["browser_click", "controlling"],
		["type", "controlling"],
		["key", "controlling"],
		["scroll", "controlling"],
		["browser_act", "controlling"],
		["delegate_task", "working"],
		["generate_image", "coding"],
		["ferramenta_desconhecida", "working"],
	];
	for (const [name, expected] of cases) assert.equal(stateOf(tool(name)), expected, name);
});

test("Lendo e Programando não são o mesmo estado (era tudo `working`)", () => {
	assert.notEqual(stateOf(tool("read_file")), stateOf(tool("edit_file")));
});

test("esperando você, aprovação, fila e pausa viram waiting, mesmo no meio de uma ferramenta", () => {
	assert.equal(stateOf(tool("shell"), { status: "waiting_user" }), "waiting");
	assert.equal(stateOf({ phase: "writing" }, { pendingApproval: true }), "waiting");
	assert.equal(stateOf(tool("navigate"), { paused: true }), "waiting");
	// fila / nova tentativa / espera externa / pausando NÃO são espera do usuário
	for (const status of ["queued", "retrying", "waiting_external", "pausing", "running"]) {
		assert.notEqual(stateOf({ phase: "thinking" }, { status }), "waiting", status);
		assert.equal(stateOf(tool("read_file"), { status }), "reading", status);
	}
	assert.equal(stateOf({ phase: "idle" }, { status: "queued" }), "working");
	assert.equal(stateOf(tool("navigate"), { status: "running" }), "searching");
	assert.equal(stateOf(tool("navigate"), { status: null }), "searching");
});

test("fração do passo bate com o texto do indicador (passo {step+1} de {max})", () => {
	assert.equal(stepProgress(2, 8), 3 / 8);
	assert.equal(stepProgress(0, 4), 0.25);
	assert.equal(stepProgress(7, 8), 1);
	assert.equal(stepProgress(9, 8), 1, "acima do total trava em 100%");
	assert.equal(stepProgress(undefined, 8), null);
	assert.equal(stepProgress(2, undefined), null);
	assert.equal(stepProgress(2, 0), null);
	assert.equal(stepProgress(Number.NaN, 8), null);
	const d = avatarStateForActivity(tool("read_file", { step: 2, maxSteps: 8 }));
	assert.equal(d.progress, 3 / 8);
	assert.equal(d.step, 2);
	assert.equal(avatarStateForActivity(tool("read_file")).progress, null);
	assert.equal(avatarStateForActivity({ phase: "writing" }).progress, null);
});

test("a classificação é a mesma do texto: toolKind é a fonte única", () => {
	assert.equal(toolKind("navigate"), "navigate");
	assert.equal(toolKind("browser_links"), "navigate");
	assert.equal(toolKind("key"), "type");
	assert.equal(toolKind("browser_act"), "act");
	assert.equal(toolKind("delegate_task"), "delegate");
	assert.equal(toolKind("mcp__gmail__search_messages"), "web");
});

test("ferramentas de leitura e de raciocínio ganham gesto próprio em vez de 'trabalhando'", () => {
	const state = (tool: string) => avatarStateForActivity({ phase: "tool", tool, step: 0, maxSteps: 4 }).state;
	assert.equal(state("browser_snapshot"), "reading");
	assert.equal(state("browser_find"), "reading");
	assert.equal(state("mcp__github__read_things"), "reading");
	assert.equal(state("mcp__notion__search"), "searching");
	assert.equal(state("dev_ci_logs"), "reading");
	assert.equal(state("lint"), "running");
	assert.equal(state("generate_image"), "coding");
	assert.equal(state("todo_write"), "thinking");
	assert.equal(state("mcp__notion__create_page"), "working");
});
