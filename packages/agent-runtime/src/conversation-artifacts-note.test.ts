import { expect, test } from "vitest";
import type { ChatMessage } from "@workspace/shared";
import { buildConversationArtifactsNote, insertBeforeLastUser } from "./conversation-artifacts-note.js";

const note: ChatMessage = { role: "system", content: "note" };

test("insertBeforeLastUser: nota entra antes da última mensagem de usuário", () => {
	const messages: ChatMessage[] = [
		{ role: "user", content: "a" },
		{ role: "assistant", content: "b" },
		{ role: "user", content: "objetivo" },
	];
	const out = insertBeforeLastUser(messages, note);
	expect(out.map((m) => m.content)).toEqual(["a", "b", "note", "objetivo"]);
	expect(messages.length).toBe(3);
});

test("insertBeforeLastUser: sem usuário no fim, a nota vai ao final", () => {
	expect(insertBeforeLastUser([{ role: "assistant", content: "x" }], note).map((m) => m.content)).toEqual(["x", "note"]);
	expect(insertBeforeLastUser([], note).map((m) => m.content)).toEqual(["note"]);
});

test("buildConversationArtifactsNote: vazio vira null, limita a 5 e a 80 chars no nome", () => {
	expect(buildConversationArtifactsNote([])).toBe(null);
	const many = Array.from({ length: 8 }, (_, i) => ({ id: `art-${i}`, name: `n${"x".repeat(100)}\nz` }));
	const built = buildConversationArtifactsNote(many);
	const content = String(built?.content);
	expect(content).toMatch(/artifact_read/);
	expect(content.includes("art-4")).toBe(true);
	expect(content.includes("art-5")).toBe(false);
	expect(content.includes("\n")).toBe(false);
	expect(content.includes("x".repeat(80))).toBe(false);
});
