import assert from "node:assert/strict";
import test from "node:test";

import { buildTestPrMessage } from "@workspace/shared";
import { CHAT_SEND_REQUEST_EVENT, onChatMessageRequest, requestChatMessage } from "@/lib/dev-session/chat-send-request";

test("pedido de envio ao chat: o ouvinte recebe o texto; vazio é ignorado", () => {
	const target = new EventTarget();
	const received: string[] = [];
	Object.assign(globalThis, { window: Object.assign(target, { CustomEvent }) });
	const off = onChatMessageRequest((text) => received.push(text));
	requestChatMessage(buildTestPrMessage({ repo: "octo/hello", number: 7 }));
	requestChatMessage("   ");
	off();
	requestChatMessage("depois de desligar");
	assert.deepEqual(received, ["Testa a PR #7 de octo/hello: faça checkout, instale, rode testes/typecheck/lint/build, veja o CI e diga se pode dar merge."]);
	assert.equal(CHAT_SEND_REQUEST_EVENT, "chat:send-request");
	delete (globalThis as { window?: unknown }).window;
});
