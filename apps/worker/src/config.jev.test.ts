import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJevModes } from "./config.js";

test("chaves JEV_*_MODE: padrão off, aceita shadow e on, ignora lixo", () => {
	assert.deepEqual(parseJevModes({}), { intent: "off", tools: "off", verify: "off", blockpage: "off", delegate: "off", stuck: "off" });
	assert.deepEqual(
		parseJevModes({
			JEV_INTENT_MODE: "on",
			JEV_TOOLS_MODE: " Shadow ",
			JEV_VERIFY_MODE: "gate",
			JEV_BLOCKPAGE_MODE: "ON",
			JEV_DELEGATE_MODE: "",
			JEV_STUCK_MODE: "yes",
		}),
		{ intent: "on", tools: "shadow", verify: "off", blockpage: "on", delegate: "off", stuck: "off" },
	);
});
