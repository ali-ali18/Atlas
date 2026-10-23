import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "./bot-thread";
import { planImageRuns, reuseImageRuns } from "./image-groups";

const img = (artifactId: string) => ({ artifactId, mime: "image/png", width: 10, height: 10 });
const images = (id: string, source: "user" | "assistant", ...ids: string[]): ThreadItem => ({
	type: "message",
	id,
	message: { id, kind: "images", source, items: ids.map(img) },
});
const text = (id: string): ThreadItem => ({ type: "message", id, message: { id, kind: "assistant", text: "oi" } as never });

test("imagens consecutivas da mesma origem viram um grupo", () => {
	const plan = planImageRuns([images("a", "assistant", "1"), images("b", "assistant", "2"), images("c", "assistant", "3")]);
	assert.deepEqual(plan.get("a")?.items.map((i) => i.artifactId), ["1", "2", "3"]);
	assert.equal(plan.get("b"), null);
	assert.equal(plan.get("c"), null);
});

test("texto no meio, origem diferente ou separador quebram o grupo", () => {
	const plan = planImageRuns([images("a", "assistant", "1"), text("t"), images("b", "assistant", "2"), images("c", "user", "3"), images("d", "user", "4")], new Map([["d", "10:00"]]));
	assert.equal(plan.get("a")?.items.length, 1);
	assert.equal(plan.get("b")?.items.length, 1);
	assert.equal(plan.get("c")?.items.length, 1);
	assert.equal(plan.get("d")?.items.length, 1);
});

test("uma mensagem com várias imagens mantém todas", () => {
	assert.equal(planImageRuns([images("a", "assistant", "1", "2")]).get("a")?.items.length, 2);
});

test("plano refeito com as mesmas imagens devolve o mesmo baralho (referência estável para o memo da linha)", () => {
	const thread = [images("a", "assistant", "1"), images("b", "assistant", "2"), text("t")];
	const first = planImageRuns(thread);
	const again = reuseImageRuns(planImageRuns(thread), first);
	assert.equal(again.get("a"), first.get("a"));
	const grown = reuseImageRuns(planImageRuns([...thread.slice(0, 2), images("c", "assistant", "3")]), first);
	assert.notEqual(grown.get("a"), first.get("a"));
	assert.equal(grown.get("a")?.items.length, 3);
});
