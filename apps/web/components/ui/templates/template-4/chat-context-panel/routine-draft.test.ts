import assert from "node:assert/strict";
import test from "node:test";
import {
	canAutosaveRoutine,
	createDebouncedSaver,
	isRoutineDraftValid,
	ROUTINE_AUTOSAVE_DEBOUNCE_MS,
} from "./routine-draft";

function fakeTimers() {
	let next = 1;
	const jobs = new Map<number, () => void>();
	return {
		set: (fn: () => void) => {
			jobs.set(next, fn);
			return next++;
		},
		clear: (h: unknown) => void jobs.delete(h as number),
		fire: () => {
			const all = [...jobs.values()];
			jobs.clear();
			for (const job of all) job();
		},
		size: () => jobs.size,
	};
}

test("debounce mínimo é de pelo menos 1.2s", () => {
	assert.ok(ROUTINE_AUTOSAVE_DEBOUNCE_MS >= 1200);
});

test("rascunho exige nome, instrução e gatilho", () => {
	const ok = { name: "A", instruction: "B", triggers: [{}] };
	assert.equal(isRoutineDraftValid(ok), true);
	assert.equal(isRoutineDraftValid({ ...ok, name: "  " }), false);
	assert.equal(isRoutineDraftValid({ ...ok, instruction: "" }), false);
	assert.equal(isRoutineDraftValid({ ...ok, triggers: [] }), false);
});

test("autosave de rotina criada não roda com nome vazio", () => {
	assert.equal(canAutosaveRoutine({ name: " " }), false);
	assert.equal(canAutosaveRoutine({ name: "x" }), true);
});

test("digitar várias vezes salva uma vez só, com o último valor", () => {
	const timers = fakeTimers();
	const saved: string[] = [];
	const saver = createDebouncedSaver<string>((v) => saved.push(v), 1200, timers);
	saver.schedule("a");
	saver.schedule("ab");
	saver.schedule("abc");
	assert.deepEqual(saved, []);
	timers.fire();
	assert.deepEqual(saved, ["abc"]);
});

test("flush (blur/fechar) salva o pendente na hora e não repete", () => {
	const timers = fakeTimers();
	const saved: string[] = [];
	const saver = createDebouncedSaver<string>((v) => saved.push(v), 1200, timers);
	saver.schedule("x");
	saver.flush();
	saver.flush();
	timers.fire();
	assert.deepEqual(saved, ["x"]);
	assert.equal(saver.hasPending(), false);
});

test("controles discretos salvam imediatamente", () => {
	const timers = fakeTimers();
	const saved: string[] = [];
	const saver = createDebouncedSaver<string>((v) => saved.push(v), 1200, timers);
	saver.schedule("texto");
	saver.schedule("select", true);
	assert.deepEqual(saved, ["select"]);
	assert.equal(timers.size(), 0);
});

test("cancel descarta o pendente", () => {
	const timers = fakeTimers();
	const saved: string[] = [];
	const saver = createDebouncedSaver<string>((v) => saved.push(v), 1200, timers);
	saver.schedule("x");
	saver.cancel();
	saver.flush();
	assert.deepEqual(saved, []);
});
