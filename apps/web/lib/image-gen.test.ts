import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@/components/ui/templates/template-4/data";
import { createComputerHandlers } from "@/hooks/use-atlas-chat";
import { aspectRatioValue, clearRunningImageGen, normalizeAspectRatio, parseGenerateImageCall } from "./image-gen";

function harness() {
	let messages: Message[] = [{ id: "u1", kind: "user", text: "gera uma imagem de um gato astronauta" } as Message];
	const handlers = createComputerHandlers({
		runId: "run-1",
		setMessages: (update: Message[] | ((previous: Message[]) => Message[])) => { messages = typeof update === "function" ? update(messages) : update; },
	} as never);
	return { handlers, get messages() { return messages; } };
}
const call = (id: string, args: Record<string, unknown>) => ({ id, name: "generate_image", args: JSON.stringify(args), step: 1, maxSteps: 10 });
const images = (artifactId: string) => ({ type: "images" as const, origin: "assistant" as const, items: [{ artifactId, mime: "image/png", width: 1024, height: 1024 }] });

test("proporção: lê, normaliza e cai em 1:1", () => {
	assert.equal(normalizeAspectRatio("16:9"), "16:9");
	assert.equal(normalizeAspectRatio("0:9"), "1:1");
	assert.equal(normalizeAspectRatio("wide"), "1:1");
	assert.equal(normalizeAspectRatio(undefined), "1:1");
	assert.equal(aspectRatioValue("16:9").toFixed(3), "1.778");
	assert.deepEqual(parseGenerateImageCall(JSON.stringify({ prompt: "x", n: 2, aspect_ratio: "9:16" })), { count: 2, aspectRatio: "9:16" });
	assert.deepEqual(parseGenerateImageCall("{"), { count: 1, aspectRatio: "1:1" });
});

test("tool_call de generate_image abre o skeleton com n e proporção pedidos", () => {
	const h = harness();
	h.handlers.onToolCall?.(call("c1", { prompt: "gato", n: 2, aspect_ratio: "16:9" }));
	const card = h.messages.find((m) => m.kind === "image-gen");
	assert.ok(card && card.kind === "image-gen");
	assert.equal(card.count, 2);
	assert.equal(card.aspectRatio, "16:9");
	assert.equal(card.status, "running");
	h.handlers.onToolCall?.(call("c1", { prompt: "gato", n: 2, aspect_ratio: "16:9" }));
	assert.equal(h.messages.filter((m) => m.kind === "image-gen").length, 1);
});

test("as imagens trocam o skeleton na mesma posição", () => {
	const h = harness();
	h.handlers.onToolCall?.(call("c1", { prompt: "gato" }));
	const index = h.messages.findIndex((m) => m.kind === "image-gen");
	h.handlers.onImages?.(images("art-1"));
	assert.equal(h.messages.some((m) => m.kind === "image-gen"), false);
	assert.equal(h.messages.findIndex((m) => m.kind === "images"), index);
	h.handlers.onToolResult?.({ id: "c1", name: "generate_image", ok: true, summary: "Imagem gerada: 1." });
	assert.equal(h.messages.filter((m) => m.kind === "images").length, 1);
});

test("erro vira estado de erro no mesmo cartão", () => {
	const h = harness();
	h.handlers.onToolCall?.(call("c1", { prompt: "gato" }));
	h.handlers.onToolResult?.({ id: "c1", name: "generate_image", ok: false, summary: "Geração de imagem falhou (HTTP 402). No credits" });
	const card = h.messages.find((m) => m.kind === "image-gen");
	assert.ok(card && card.kind === "image-gen");
	assert.equal(card.status, "error");
	assert.match(card.error ?? "", /HTTP 402/);
});

test("pedido de confirmação (sem imagem) remove o skeleton", () => {
	const h = harness();
	h.handlers.onToolCall?.(call("c1", { prompt: "gato" }));
	h.handlers.onToolResult?.({ id: "c1", name: "generate_image", ok: true, summary: "Card de confirmação de custo enviado." });
	assert.equal(h.messages.some((m) => m.kind === "image-gen"), false);
});

test("fim do run sem imagem não deixa skeleton órfão", () => {
	const h = harness();
	h.handlers.onToolCall?.(call("c1", { prompt: "gato" }));
	h.handlers.onDone?.({} as never);
	assert.equal(h.messages.some((m) => m.kind === "image-gen"), false);
	const h2 = harness();
	h2.handlers.onToolCall?.(call("c2", { prompt: "gato" }));
	h2.handlers.onToolResult?.({ id: "c2", name: "generate_image", ok: false, summary: "falhou" });
	h2.handlers.onDone?.({} as never);
	assert.equal(h2.messages.some((m) => m.kind === "image-gen" && m.status === "error"), true);
	assert.deepEqual(clearRunningImageGen([]), []);
});
