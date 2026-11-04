import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { carryLimitOutcome } from "./runs.js";

const checkpoint = (limitWait: Record<string, unknown> | undefined): AgentRunCheckpoint =>
	({ version: 2, messages: [], engine: "v3", engineV3: { ...(limitWait ? { limitWait } : {}) } }) as unknown as AgentRunCheckpoint;
const wait = { cardId: "confirm-limit1-run1", kind: "steps", steps: 40 };

test("gravação tardia do worker não apaga a decisão do dono no cartão do limite (mesmo cartão)", () => {
	const next = carryLimitOutcome(checkpoint(wait), checkpoint({ ...wait, outcome: "continue" }));
	assert.equal((next.engineV3?.limitWait as { outcome?: string }).outcome, "continue");
});

test("cartão diferente, decisão nova ou sem espera: o checkpoint que chega vale como está", () => {
	const other = checkpoint({ ...wait, cardId: "confirm-limit2-run1" });
	assert.equal(carryLimitOutcome(other, checkpoint({ ...wait, outcome: "continue" })), other);
	const decided = checkpoint({ ...wait, outcome: "stop" });
	assert.equal(carryLimitOutcome(decided, checkpoint({ ...wait, outcome: "continue" })), decided);
	const none = checkpoint(undefined);
	assert.equal(carryLimitOutcome(none, checkpoint({ ...wait, outcome: "continue" })), none);
	assert.equal(carryLimitOutcome(checkpoint(wait), null).engineV3?.limitWait, wait);
});
