import assert from "node:assert/strict";
import { test } from "node:test";
import { countEstablished, countUserProcesses, countViewerClients, createActivityTracker } from "./activity.mjs";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (local, remote, st) => `   0: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000     0        0 1 1 0\n`;

test("conta só conexões ESTABLISHED na porta do noVNC (6080 = 17C0)", () => {
	const tcp =
		HEADER +
		row("00000000:17C0", "00000000:0000", "0A") + // listen
		row("0100007F:17C0", "0100007F:D2F4", "01") + // cliente conectado
		row("0100007F:17C0", "0100007F:D2F5", "01") +
		row("0100007F:170C", "0100007F:D2F6", "01") + // outra porta
		row("0100007F:17C0", "0100007F:D2F7", "06"); // TIME_WAIT
	assert.equal(countEstablished(tcp, 6080), 2);
	assert.equal(countViewerClients((path) => (path.endsWith("tcp6") ? HEADER + row("00000000000000000000000001000000:17C0", "0:0", "01") : tcp)), 3);
	assert.equal(countViewerClients(() => { throw new Error("sem /proc"); }), 0);
});

test("conta processos do usuário do shell do agente", () => {
	const status = { 1: "Name:\tx\nUid:\t0\t0\t0\t0\n", 20: "Name:\tsleep\nUid:\t1001\t1001\t1001\t1001\n", 21: "Name:\tbash\nUid:\t1001\t1001\t1001\t1001\n" };
	const deps = { listDir: () => ["1", "20", "21", "self", "net"], read: (path) => status[Number(path.split("/")[2])] ?? "" };
	assert.equal(countUserProcesses(1001, deps), 2);
	assert.equal(countUserProcesses(0, deps), 1);
	assert.equal(countUserProcesses(1001, { listDir: () => { throw new Error("x"); } }), 0);
});

test("ocioso só sem chamada em andamento, sem viewer e sem processo do shell", () => {
	let t = 1_000;
	const state = { viewers: 0, shell: 0 };
	const tracker = createActivityTracker({ now: () => t, viewers: () => state.viewers, shellProcesses: () => state.shell });
	t += 5 * 60_000;
	assert.equal(tracker.snapshot().idleMs, 5 * 60_000);
	assert.equal(tracker.snapshot().busy, false);

	state.viewers = 1; // pessoa digitando senha/2FA no viewer
	assert.deepEqual([tracker.snapshot().idleMs, tracker.snapshot().busy], [0, true]);
	state.viewers = 0;

	state.shell = 2; // comando longo no shell
	assert.equal(tracker.snapshot().idleMs, 0);
	state.shell = 0;

	tracker.begin(); // ferramenta em andamento por mais de 2 min
	t += 10 * 60_000;
	assert.deepEqual([tracker.snapshot().idleMs, tracker.snapshot().inFlight], [0, 1]);
	tracker.end();
	t += 30_000;
	assert.equal(tracker.snapshot().idleMs, 30_000);
	tracker.end(); // end sobrando não deixa o contador negativo
	assert.equal(tracker.snapshot().inFlight, 0);
});
