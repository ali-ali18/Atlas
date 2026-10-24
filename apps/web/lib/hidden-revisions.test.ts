import assert from "node:assert/strict";
import test from "node:test";

import { isRevisedDraftMessage } from "./hidden-revisions";

test("rascunho revisado some da conversa; resposta normal fica", () => {
	assert.equal(isRevisedDraftMessage({ id: "a", kind: "assistant", text: "rascunho", revised: "items_open" }), true);
	assert.equal(isRevisedDraftMessage({ id: "b", kind: "assistant", text: "final" }), false);
	assert.equal(isRevisedDraftMessage({ id: "c", kind: "user", text: "oi" } as never), false);
});
