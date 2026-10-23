import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewReporter } from "./preview-throttle";

function harness() {
	let clock = 0;
	const timers: Array<{ at: number; run: () => void; id: number }> = [];
	let nextId = 0;
	const reports: string[] = [];
	const reporter = createPreviewReporter({
		report: (botId, text) => reports.push(`${botId}:${text}`),
		now: () => clock,
		setTimer: (run, ms) => {
			const id = nextId++;
			timers.push({ at: clock + ms, run, id });
			return id;
		},
		clearTimer: (id) => {
			const index = timers.findIndex((timer) => timer.id === id);
			if (index >= 0) timers.splice(index, 1);
		},
	});
	const advance = (ms: number) => {
		clock += ms;
		for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
			if (timer.at > clock) continue;
			timers.splice(timers.indexOf(timer), 1);
			timer.run();
		}
	};
	return { reporter, reports, advance, timers };
}

test("durante o stream a prévia sai no máximo uma vez por segundo, com o texto mais novo", () => {
	const { reporter, reports, advance } = harness();
	reporter.update("c1", "bot", "Oi", true);
	for (const text of ["Oi,", "Oi, tudo", "Oi, tudo bem"]) {
		advance(100);
		reporter.update("c1", "bot", text, true);
	}
	assert.deepEqual(reports, ["bot:Oi"]);
	advance(700);
	assert.deepEqual(reports, ["bot:Oi", "bot:Oi, tudo bem"]);
});

test("fim do run (fora do stream) publica na hora o texto final e cancela o pendente", () => {
	const { reporter, reports, advance, timers } = harness();
	reporter.update("c1", "bot", "Oi", true);
	advance(100);
	reporter.update("c1", "bot", "Oi, tudo", true);
	reporter.update("c1", "bot", "Oi, tudo certo.", false);
	assert.deepEqual(reports, ["bot:Oi", "bot:Oi, tudo certo."]);
	assert.equal(timers.length, 0);
	advance(2000);
	assert.equal(reports.length, 2);
});

test("texto igual ao último publicado não repete; outra conversa publica na hora", () => {
	const { reporter, reports } = harness();
	reporter.update("c1", "bot", "Oi", false);
	reporter.update("c1", "bot", "Oi", false);
	reporter.update("c2", "bot2", "Olá", true);
	assert.deepEqual(reports, ["bot:Oi", "bot2:Olá"]);
});

test("cancelar descarta o pendente", () => {
	const { reporter, reports, advance } = harness();
	reporter.update("c1", "bot", "Oi", true);
	advance(10);
	reporter.update("c1", "bot", "Oi!", true);
	reporter.cancel();
	advance(5000);
	assert.deepEqual(reports, ["bot:Oi"]);
});
