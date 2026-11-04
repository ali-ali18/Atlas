import { describe, expect, it } from "vitest";
import { optimisticAttachmentItems } from "./attachment-items";
import type { OutgoingAttachment } from "./attachments";
import { reconcile } from "./chat-thread";
import type { ChatItem } from "./chat-types";

const image: OutgoingAttachment = { artifactId: "a1", route: "image", uri: "file:///c/a.jpg", name: "a.jpg", mime: "image/jpeg", width: 800, height: 600 };
const file: OutgoingAttachment = { artifactId: "f1", route: "file", uri: "file:///c/r.pdf", name: "r.pdf", mime: "application/pdf", size: 2048 };

describe("optimisticAttachmentItems", () => {
	it("imagens viram um cartão de imagens do usuário com a uri local; arquivo vira o cartão de arquivo", () => {
		const items = optimisticAttachmentItems("msg-1", [image, file], "2026-11-04T10:00:00.000Z");
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ kind: "images", origin: "user", images: [{ artifactId: "a1", uri: "file:///c/a.jpg", width: 800, height: 600 }] });
		expect(items[1]).toMatchObject({ kind: "web-card", card: "file", title: "r.pdf", key: "file:f1", fileId: "f1", size: 2048 });
		expect(items.every((item) => item.id.startsWith("msg-1"))).toBe(true);
	});
	it("sem dimensões usa um quadrado de reserva", () => {
		const [item] = optimisticAttachmentItems("msg-1", [{ ...image, width: undefined, height: undefined }], "t");
		expect(item).toMatchObject({ images: [{ width: 320, height: 320 }] });
	});
	it("sem anexos não gera nada", () => {
		expect(optimisticAttachmentItems("msg-1", [], "t")).toEqual([]);
	});
});

describe("junção com o gravado", () => {
	it("o cartão gravado com o mesmo arquivo substitui o otimista (sem duplicar)", () => {
		const live = optimisticAttachmentItems("msg-1", [image, file], "t");
		const persisted: ChatItem[] = [
			{ id: "p1", kind: "images", origin: "user", images: [{ artifactId: "a1", mime: "image/jpeg", width: 800, height: 600 }] },
			{ id: "p2", kind: "web-card", card: "file", title: "r.pdf", key: "file:f1", fileId: "f1" },
		];
		expect(reconcile(persisted, live).map((item) => item.id)).toEqual(["p1", "p2"]);
	});
	it("antes de gravar, os otimistas aparecem", () => {
		const live = optimisticAttachmentItems("msg-1", [image, file], "t");
		expect(reconcile([], live)).toHaveLength(2);
	});
});
