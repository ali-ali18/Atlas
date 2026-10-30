import assert from "node:assert/strict";
import { test } from "node:test";
import { detectIos, lastUsedLabel, pushState, pushStateText, urlBase64ToUint8Array, type PushEnv } from "./push-client";

const base: PushEnv = {
	hasServiceWorker: true,
	hasPushManager: true,
	hasNotification: true,
	isIos: false,
	isStandalone: false,
	permission: "default",
	serverEnabled: true,
	subscribed: false,
};

test("estado: servidor sem VAPID, sem suporte, iPhone fora da tela inicial, bloqueado, desligado e ligado", () => {
	assert.equal(pushState({ ...base, serverEnabled: false }), "server-off");
	assert.equal(pushState({ ...base, hasPushManager: false }), "unsupported");
	assert.equal(pushState({ ...base, isIos: true, isStandalone: false }), "needs-install");
	assert.equal(pushState({ ...base, isIos: true, isStandalone: true }), "off");
	assert.equal(pushState({ ...base, permission: "denied" }), "denied");
	assert.equal(pushState(base), "off");
	assert.equal(pushState({ ...base, permission: "granted", subscribed: true }), "on");
	assert.equal(pushState({ ...base, permission: "default", subscribed: true }), "off");
});

test("todo estado tem texto em português", () => {
	const texts = (["server-off", "unsupported", "needs-install", "denied", "off", "on"] as const).map((state) => pushStateText(state));
	for (const text of texts) assert.ok(text.length > 10);
	assert.ok(!texts.join(" ").includes("Atlas"));
});

test("chave VAPID base64url vira bytes", () => {
	assert.deepEqual([...urlBase64ToUint8Array("AQID")], [1, 2, 3]);
	assert.deepEqual([...urlBase64ToUint8Array("-_8")], [251, 255]);
});

test("iPhone e iPad (inclusive iPadOS que se diz Mac)", () => {
	assert.equal(detectIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
	assert.equal(detectIos("Mozilla/5.0 (Macintosh)", 5, "MacIntel"), true);
	assert.equal(detectIos("Mozilla/5.0 (Macintosh)", 0, "MacIntel"), false);
	assert.equal(detectIos("Mozilla/5.0 (Linux; Android 14)"), false);
});

test("último uso do aparelho", () => {
	const now = Date.parse("2026-11-01T12:00:00Z");
	assert.equal(lastUsedLabel("2026-11-01T11:59:40Z", now), "agora");
	assert.equal(lastUsedLabel("2026-11-01T11:30:00Z", now), "há 30 min");
	assert.equal(lastUsedLabel("2026-11-01T07:00:00Z", now), "há 5 h");
	assert.equal(lastUsedLabel("2026-10-28T12:00:00Z", now), "há 4 d");
	assert.equal(lastUsedLabel("lixo", now), "");
});
