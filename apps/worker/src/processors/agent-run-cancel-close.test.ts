/**
 * "Parar" que chega pelo caminho do lease perdido (o heartbeat não renova run com cancel pedido):
 * fecha como o cancel direto — evento, run cancelado, entrega liquidada e follow-up encadeado.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/processors/agent-run-cancel-close.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeCancelledAfterLeaseLoss, closeCancelledRun, ownsLeaseForCancelClose, type CancelCloseIo } from "./agent-run.js";

function fakeIo(overrides: Partial<CancelCloseIo> = {}) {
	const calls: string[] = [];
	const events: unknown[] = [];
	const io: CancelCloseIo = {
		emit: async (event) => {
			calls.push("emit");
			events.push(event);
		},
		flush: async () => void calls.push("flush"),
		finish: async () => void calls.push("finish"),
		settle: async () => void calls.push("settle"),
		chain: async () => void calls.push("chain"),
		...overrides,
	};
	return { io, calls, events };
}

test("lease perdido com cancel pedido: emite cancelled, fecha o run, liquida a entrega e encadeia o follow-up, nessa ordem", async () => {
	const { io, calls, events } = fakeIo();
	await closeCancelledAfterLeaseLoss("r1", io);
	assert.deepEqual(calls, ["emit", "flush", "finish", "settle", "chain"]);
	assert.deepEqual(events, [{ type: "cancelled", reason: "Execução cancelada" }]);
});

test("cancel direto usa o mesmo fechamento e propaga falha do fechamento do run", async () => {
	const { io, calls } = fakeIo({
		finish: async () => {
			throw new Error("lease_lost");
		},
	});
	await assert.rejects(() => closeCancelledRun("parou", io), /lease_lost/);
	// Falhou ao fechar: não liquida nem encadeia (quem chamou decide).
	assert.deepEqual(calls, ["emit", "flush"]);
});

test("lease perdido: se o fechamento falha (lease tomado por outro), não lança; o varredor de cancel órfão finaliza", async () => {
	const { io } = fakeIo({
		finish: async () => {
			throw new Error("lease_lost");
		},
	});
	await closeCancelledAfterLeaseLoss("r1", io);
});

test("lease perdido com cancel pedido: outro executor dono do run → não fecha (sem cancelled nem finish)", async () => {
	const { io, calls } = fakeIo();
	const state = { cancelRequested: true, leaseOwner: "worker-b" };
	if (ownsLeaseForCancelClose(state, "worker-a")) await closeCancelledAfterLeaseLoss("r1", io);
	assert.deepEqual(calls, []);
});

test("lease do próprio executor ou livre (expirado) → pode fechar", () => {
	assert.equal(ownsLeaseForCancelClose({ leaseOwner: "worker-a" }, "worker-a"), true);
	assert.equal(ownsLeaseForCancelClose({ leaseOwner: null }, "worker-a"), true);
	assert.equal(ownsLeaseForCancelClose(null, "worker-a"), true);
	assert.equal(ownsLeaseForCancelClose({ leaseOwner: "worker-b" }, "worker-a"), false);
});
