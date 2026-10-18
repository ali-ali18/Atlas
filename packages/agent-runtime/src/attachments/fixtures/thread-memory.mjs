import { parentPort } from "node:worker_threads";

// Aloca sem parar até estourar o resourceLimits da thread.
parentPort.on("message", () => {
	const hog = [];
	for (;;) hog.push(new Array(1_000_000).fill("x".repeat(16)));
});
