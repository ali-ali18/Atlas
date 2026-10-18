import { parentPort } from "node:worker_threads";
import { threadId } from "node:worker_threads";

// Responde bem; devolve o id da thread no texto para provar o reaproveitamento.
parentPort.on("message", (message) => {
	if (message.op === "pageCount") return parentPort.postMessage({ id: message.id, ok: true, pageCount: 7 });
	parentPort.postMessage({ id: message.id, ok: true, extracted: { kind: message.kind, text: `thread ${threadId}`, tables: [], textCut: false, notes: [] } });
});
