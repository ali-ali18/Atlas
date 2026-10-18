import assert from "node:assert/strict";
import { test } from "node:test";
import {
	NOTIFICATION_OPEN_MESSAGE,
	notificationUrl,
	parseNotificationMessage,
	parseNotificationTarget,
	stripNotificationParams,
} from "./notification-link";

test("URL da notificação ida e volta", () => {
	const url = notificationUrl("bot 1", "card-9");
	assert.equal(url, "/?bot=bot+1&card=card-9");
	assert.deepEqual(parseNotificationTarget(url.slice(1)), { botId: "bot 1", cardId: "card-9" });
	assert.deepEqual(parseNotificationTarget("?bot=b2"), { botId: "b2", cardId: null });
	assert.equal(parseNotificationTarget("?x=1"), null);
});

test("mensagem do service worker", () => {
	assert.deepEqual(parseNotificationMessage({ type: NOTIFICATION_OPEN_MESSAGE, botId: "b", cardId: "c" }), { botId: "b", cardId: "c" });
	assert.equal(parseNotificationMessage({ type: "outro", botId: "b" }), null);
	assert.equal(parseNotificationMessage(null), null);
});

test("limpa só os parâmetros da notificação", () => {
	assert.equal(stripNotificationParams("?bot=b&card=c"), "");
	assert.equal(stripNotificationParams("?bot=b&x=1"), "?x=1");
});
