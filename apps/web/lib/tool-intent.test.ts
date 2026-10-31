// `tool_intent`: o avatar mostra a ação assim que o modelo escolhe a ferramenta (antes dos argumentos).
// Cobre os dois sentidos do deploy: front novo sem o evento e front antigo diante do evento novo.
import assert from "node:assert/strict";
import test from "node:test";

import type { ComputerUseEvent } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { createComputerHandlers } from "@/hooks/use-atlas-chat";
import { dispatchComputerUseEvent } from "./atlas-api";
import { beginBotRun, botAvatarSignal, endBotRun, refreshBotAvatar, setBotActivity, setBotWorking, subscribeBotPulses, type BotPulseKind } from "./bot-activity";
import { activityForToolIntent, workingStatusLabel, type AgentActivity } from "./working-status";

const tool = (name: string, step: number): AgentActivity => ({ phase: "tool", tool: name, step, maxSteps: 12 });

function harness() {
	const seen: AgentActivity[] = [];
	let messages: Message[] = [];
	const handlers = createComputerHandlers({
		runId: "run-1",
		onAgentActivity: (activity: AgentActivity) => seen.push(activity),
		setMessages: (update: Message[] | ((previous: Message[]) => Message[])) => { messages = typeof update === "function" ? update(messages) : update; },
	} as never);
	return { handlers, seen, get messages() { return messages; } };
}

test("atividade do aviso: família da ferramenta, marcada como 'chegando'; raciocínio puro não muda nada", () => {
	assert.deepEqual(activityForToolIntent("write_file"), { phase: "tool", tool: "write_file", arriving: true });
	assert.equal(activityForToolIntent("todo_write"), null);
	assert.equal(activityForToolIntent(""), null);
});

test("o texto do indicador usa a frase da família, sem nome interno da ferramenta", () => {
	const label = workingStatusLabel("Atlas", activityForToolIntent("write_file")!);
	assert.doesNotMatch(label, /write_file/);
	const mcp = workingStatusLabel("Atlas", activityForToolIntent("mcp__github__create_issue")!);
	assert.doesNotMatch(mcp, /mcp__|create_issue/);
});

test("handler: tool_intent publica a ferramenta; tool_call e tool_result seguem o fluxo de sempre", () => {
	const h = harness();
	dispatchComputerUseEvent({ type: "tool_intent", name: "write_file", callId: "c1" }, h.handlers);
	dispatchComputerUseEvent({ type: "tool_call", id: "c1", name: "write_file", args: '{"path":"a.ts"}', step: 2, maxSteps: 12 }, h.handlers);
	dispatchComputerUseEvent({ type: "tool_result", id: "c1", name: "write_file", ok: true, summary: "ok" }, h.handlers);
	assert.deepEqual(h.seen.map((a) => a.phase), ["tool", "tool", "thinking"]);
	assert.equal((h.seen[0] as { arriving?: boolean }).arriving, true);
	assert.equal((h.seen[1] as { arriving?: boolean }).arriving, undefined);
	assert.equal((h.seen[1] as { step?: number }).step, 2);
	assert.equal(h.messages.length, 0, "o aviso não cria mensagem no chat");
});

test("compat (front novo, servidor antigo): sem tool_intent o fluxo é idêntico ao de antes", () => {
	const h = harness();
	dispatchComputerUseEvent({ type: "tool_call", id: "c1", name: "run_code", args: "{}", step: 0, maxSteps: 12 }, h.handlers);
	dispatchComputerUseEvent({ type: "tool_result", id: "c1", name: "run_code", ok: false, summary: "falhou" }, h.handlers);
	assert.deepEqual(h.seen, [{ phase: "tool", tool: "run_code", step: 0, maxSteps: 12 }, { phase: "thinking", toolFailed: true }]);
});

test("compat (front antigo, servidor novo): handlers sem onToolIntent e tipos desconhecidos são ignorados sem erro", () => {
	const old = { onDelta: () => assert.fail("não deveria chamar") } as never;
	assert.doesNotThrow(() => dispatchComputerUseEvent({ type: "tool_intent", name: "write_file" }, old));
	assert.doesNotThrow(() => dispatchComputerUseEvent({ type: "evento_do_futuro", x: 1 } as unknown as ComputerUseEvent, old));
	assert.doesNotThrow(() => dispatchComputerUseEvent({ type: "tool_intent", name: 42 } as unknown as ComputerUseEvent, createComputerHandlers({ setMessages: () => undefined } as never)));
});

test("aviso sem nome utilizável não publica nada", () => {
	const h = harness();
	dispatchComputerUseEvent({ type: "tool_intent", name: "" }, h.handlers);
	dispatchComputerUseEvent({ type: "tool_intent", name: "todo_write" }, h.handlers);
	assert.equal(h.seen.length, 0);
});

test("avatar: aviso vira a família da ferramenta na hora; o tool_call seguinte não repete o gesto de início", () => {
	const id = "ti1";
	const t0 = 5_000_000;
	const pulses: BotPulseKind[] = [];
	const off = subscribeBotPulses(id, (kind) => pulses.push(kind));
	setBotWorking(id, true);
	beginBotRun(id, t0);
	setBotActivity(id, { phase: "thinking" }, { status: "queued" }, t0);
	setBotActivity(id, activityForToolIntent("write_file")!, { status: "queued" }, t0 + 1_000);
	refreshBotAvatar(id, t0 + 1_100);
	assert.equal(botAvatarSignal(id).state, "coding");
	setBotActivity(id, tool("write_file", 3), { status: "queued" }, t0 + 9_000);
	assert.equal(botAvatarSignal(id).state, "coding");
	setBotActivity(id, { phase: "thinking" }, { status: "queued" }, t0 + 9_500);
	assert.deepEqual(pulses, ["toolStart", "toolOk"], "um início só");
	off();
	setBotWorking(id, false);
	endBotRun(id, "ok", t0 + 10_000);
});

test("avatar: modelo desistiu (aviso sem tool_call, depois texto) volta ao normal, sem estado preso", () => {
	const id = "ti2";
	const t0 = 6_000_000;
	setBotWorking(id, true);
	beginBotRun(id, t0);
	setBotActivity(id, activityForToolIntent("run_code")!, {}, t0);
	refreshBotAvatar(id, t0 + 100);
	assert.equal(botAvatarSignal(id).state, "running");
	setBotActivity(id, { phase: "writing" }, {}, t0 + 3_000);
	assert.equal(botAvatarSignal(id).state, "streaming");
	setBotActivity(id, { phase: "idle" }, {}, t0 + 4_000); // erro: o hook publica idle
	setBotWorking(id, false);
	endBotRun(id, "error", t0 + 4_000);
	refreshBotAvatar(id, t0 + 30_000);
	assert.equal(botAvatarSignal(id).state, "idle");
});
