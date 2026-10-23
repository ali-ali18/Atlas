import assert from "node:assert/strict";
import test from "node:test";
import { sameRoutineRuns } from "./routine-map";

const run = (id: string, name = "Resumo · ok", time = "10:00") => ({ id, name, time });

test("mesma lista de execuções (id, nome, horário) não troca o estado", () => {
	assert.equal(sameRoutineRuns([run("a"), run("b")], [run("a"), run("b")]), true);
	assert.equal(sameRoutineRuns([], []), true);
});

test("execução nova, removida ou com rótulo diferente troca", () => {
	assert.equal(sameRoutineRuns([run("a")], [run("b"), run("a")]), false);
	assert.equal(sameRoutineRuns([run("a"), run("b")], [run("a")]), false);
	assert.equal(sameRoutineRuns([run("a", "Resumo · rodando")], [run("a", "Resumo · ok")]), false);
	assert.equal(sameRoutineRuns([run("a")], [run("a", undefined, "10:05")]), false);
});
