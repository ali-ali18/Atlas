export * from "./clock.js";
export * from "./events.js";
export * from "./llm.js";
export * from "./queue.js";
export * from "./random.js";
export * from "./sandbox.js";
export * from "./store.js";
export * from "./vault.js";

import type { Clock } from "./clock.js";
import type { Events } from "./events.js";
import type { Llm } from "./llm.js";
import type { Queue } from "./queue.js";
import type { Random } from "./random.js";
import type { Sandbox } from "./sandbox.js";
import type { Store } from "./store.js";
import type { Vault } from "./vault.js";

/** Tudo de fora que o motor recebe; o worker monta, o teste mocka. */
export type Ports = {
	llm: Llm;
	store: Store;
	queue: Queue;
	sandbox: Sandbox;
	vault: Vault;
	clock: Clock;
	random: Random;
	events: Events;
};
