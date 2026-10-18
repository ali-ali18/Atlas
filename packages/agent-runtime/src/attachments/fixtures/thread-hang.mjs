import { parentPort } from "node:worker_threads";

// Laço síncrono infinito: só terminate() resolve (abort cooperativo não alcança).
parentPort.on("message", (message) => {
	if (message.op === "pageCount") return parentPort.postMessage({ id: message.id, ok: true, pageCount: 3 });
	for (;;) { /* trava a thread */ }
});
