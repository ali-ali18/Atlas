import assert from "node:assert/strict";
import { test } from "node:test";
import { hasUnreadResults } from "./delivery-badge";

test("badge só com resultado não visto", () => {
	assert.equal(hasUnreadResults({ unreadResults: 2 }), true);
	assert.equal(hasUnreadResults({ unreadResults: 0 }), false);
	assert.equal(hasUnreadResults({}), false);
});
