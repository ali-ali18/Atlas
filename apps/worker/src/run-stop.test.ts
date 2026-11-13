/**
 * Motivo de término do run (F0 do ADR 0002): mapeamento dos erros do runtime para `stopReason`.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/run-stop.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRunLoopDetectedError, AgentRunPausedError, BudgetExhaustedError } from "@workspace/agent-runtime";
import { pausedStopReason, stopOfBudgetError, stopOfFailure } from "./run-stop.js";

test("orçamento: cada kind vira o seu motivo e a retomada automática vai no detalhe", () => {
	assert.deepEqual(stopOfBudgetError(new BudgetExhaustedError("x", "steps"), false), { reason: "budget_steps" });
	assert.deepEqual(stopOfBudgetError(new BudgetExhaustedError("x", "steps"), true), { reason: "budget_steps", detail: "auto_continue" });
	assert.equal(stopOfBudgetError(new BudgetExhaustedError("x", "wall"), false).reason, "budget_wall");
	assert.equal(stopOfBudgetError(new BudgetExhaustedError("x", "cost"), false).reason, "budget_cost");
	assert.equal(stopOfBudgetError(new BudgetExhaustedError("x", "tokens"), false).reason, "budget_tokens");
	assert.equal(stopOfBudgetError(new BudgetExhaustedError("x", "context"), false).reason, "budget_context");
	assert.equal(stopOfBudgetError(new BudgetExhaustedError("x", "stalled"), false).reason, "budget_stalled");
	assert.equal(stopOfBudgetError(new BudgetExhaustedError("x"), false).reason, "other");
});

test("loop: o tipo da trava decide o motivo", () => {
	assert.equal(stopOfFailure(new AgentRunLoopDetectedError("x", "repeat"), "permanent").reason, "loop_repeat");
	assert.equal(stopOfFailure(new AgentRunLoopDetectedError("x", "stall_guard"), "permanent").reason, "loop_stall_guard");
	assert.equal(stopOfFailure(new AgentRunLoopDetectedError("x", "tool_failures"), "permanent").reason, "tool_failures");
	assert.equal(stopOfFailure(new AgentRunLoopDetectedError("x", "truncated"), "permanent").reason, "truncated");
	assert.equal(stopOfFailure(new AgentRunLoopDetectedError("x", "no_progress"), "permanent").reason, "no_progress");
});

test("falha comum vira error com a classe no detalhe; espera pelo usuário vira awaiting_confirmation", () => {
	assert.deepEqual(stopOfFailure(new Error("boom"), "permanent"), { reason: "error", detail: "permanent" });
	assert.deepEqual(stopOfFailure(new Error("login"), "waiting_user"), { reason: "awaiting_confirmation", detail: "waiting_user" });
});

test("pausa: o v4 esperando o dono grava awaiting_owner; pausa de login/conector (com ou sem texto) segue paused_login", () => {
	assert.equal(pausedStopReason(new AgentRunPausedError("awaiting_owner", "awaiting_owner")), "awaiting_owner");
	assert.equal(pausedStopReason(new AgentRunPausedError("Aguardando o login do usuário")), "paused_login");
	assert.equal(pausedStopReason(new AgentRunPausedError()), "paused_login");
	// o texto sozinho não decide: só o campo estruturado
	assert.equal(pausedStopReason(new AgentRunPausedError("awaiting_owner")), "paused_login");
});
