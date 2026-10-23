import assert from "node:assert/strict";
import test from "node:test";
import { createStableHandlers } from "./stable-handlers";

test("handlers estáveis chamam sempre a versão mais nova, com os mesmos argumentos", () => {
	const calls: string[] = [];
	let current = { onPick: (id: string, n: number) => calls.push(`v1:${id}:${n}`) };
	const stable = createStableHandlers(["onPick"], () => current);
	const first = stable.onPick;
	stable.onPick("a", 1);
	current = { onPick: (id: string, n: number) => calls.push(`v2:${id}:${n}`) };
	stable.onPick("b", 2);
	assert.equal(stable.onPick, first);
	assert.deepEqual(calls, ["v1:a:1", "v2:b:2"]);
});

test("MessageRow e AssistantMessage são memoizados (linhas fora do stream não redesenham a cada token)", async () => {
	const memo = Symbol.for("react.memo");
	const { MessageRow } = await import("./message-row");
	const { AssistantMessage } = await import("./assistant-message");
	assert.equal(Reflect.get(MessageRow, "$$typeof"), memo);
	assert.equal(Reflect.get(AssistantMessage, "$$typeof"), memo);
});
