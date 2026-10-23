import assert from "node:assert/strict";
import test from "node:test";
import { DEGRADED_POLL_MS } from "./event-hub-client";
import { GROUP_STATE_BUSY_MS, GROUP_STATE_IDLE_MAX_MS, groupStateIdleDelay, groupStatePollDue } from "./group-state-poll";

test("ocupado consulta a cada tick, em qualquer modo", () => {
	for (const mode of ["hub", "degraded", "legacy"] as const) {
		assert.equal(groupStatePollDue({ mode, busy: true, now: 1000, lastRunAt: 999, idleStreak: 5 }), true);
	}
});

test("parado com hub conectado não consulta; com hub caindo só a consulta lenta", () => {
	assert.equal(groupStatePollDue({ mode: "hub", busy: false, now: 10_000_000, lastRunAt: 0, idleStreak: 0 }), false);
	assert.equal(groupStatePollDue({ mode: "degraded", busy: false, now: DEGRADED_POLL_MS - 1, lastRunAt: 0, idleStreak: 0 }), false);
	assert.equal(groupStatePollDue({ mode: "degraded", busy: false, now: DEGRADED_POLL_MS, lastRunAt: 0, idleStreak: 0 }), true);
});

test("parado sem hub recua dobrando até o teto", () => {
	assert.equal(groupStateIdleDelay(0), GROUP_STATE_BUSY_MS);
	assert.equal(groupStateIdleDelay(1), GROUP_STATE_BUSY_MS * 2);
	assert.equal(groupStateIdleDelay(50), GROUP_STATE_IDLE_MAX_MS);
	assert.equal(groupStatePollDue({ mode: "legacy", busy: false, now: 2999, lastRunAt: 0, idleStreak: 1 }), false);
	assert.equal(groupStatePollDue({ mode: "legacy", busy: false, now: 3000, lastRunAt: 0, idleStreak: 1 }), true);
});
