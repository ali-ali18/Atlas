import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOAST_MS, MAX_TOASTS, createToastStore } from "@workspace/ui/lib/toast-store";

test("toast entra, notifica quem assina e some sozinho", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const store = createToastStore();
	let notified = 0;
	store.subscribe(() => {
		notified += 1;
	});
	store.push("Não deu para fixar o Cookie. Tente de novo.", { tone: "error" });
	assert.equal(store.getSnapshot().length, 1);
	assert.equal(store.getSnapshot()[0]?.tone, "error");
	t.mock.timers.tick(DEFAULT_TOAST_MS);
	assert.equal(store.getSnapshot().length, 0);
	assert.equal(notified, 2);
});

test("mensagem repetida substitui a anterior e a fila tem limite", () => {
	const store = createToastStore();
	store.push("igual", { tone: "error", duration: 0 });
	store.push("igual", { tone: "error", duration: 0 });
	assert.equal(store.getSnapshot().length, 1);
	for (let index = 0; index < MAX_TOASTS + 2; index += 1) store.push(`msg ${index}`, { duration: 0 });
	assert.equal(store.getSnapshot().length, MAX_TOASTS);
	assert.equal(store.getSnapshot().at(-1)?.message, `msg ${MAX_TOASTS + 1}`);
	store.clear();
	assert.equal(store.getSnapshot().length, 0);
});

test("toast com ação guarda rótulo e callback", () => {
	const store = createToastStore();
	let called = false;
	store.push("Falhou", { duration: 0, actionLabel: "Tentar de novo", onAction: () => { called = true; } });
	const item = store.getSnapshot()[0];
	assert.equal(item?.actionLabel, "Tentar de novo");
	item?.onAction?.();
	assert.equal(called, true);
	store.clear();
});
