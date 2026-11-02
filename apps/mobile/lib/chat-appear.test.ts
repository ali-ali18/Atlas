import { describe, expect, it } from "vitest";
import type { ChatItem } from "@/lib/chat-types";
import { createNewItemTracker } from "./chat-appear";

const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text, createdAt: "2026-11-02T00:00:00Z" });
const bot = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text, createdAt: "2026-11-02T00:00:00Z" });

describe("createNewItemTracker", () => {
	it("a primeira lista não anima; o que chega no fim anima uma vez só", () => {
		const t = createNewItemTracker();
		expect([...t.next([user("a", "oi")])]).toEqual([]);
		expect([...t.next([user("a", "oi"), user("b", "tudo bem?")])]).toEqual(["b"]);
		expect([...t.next([user("a", "oi"), user("b", "tudo bem?")])]).toEqual([]);
	});
	it("troca da otimista e da resposta ao vivo pela salva (id novo, mesmo texto) não anima", () => {
		const t = createNewItemTracker();
		t.next([]);
		expect([...t.next([user("msg-1", "oi"), bot("live", "Ol")])]).toEqual(["msg-1", "live"]);
		expect([...t.next([user("msg-1", "oi"), bot("live", "Olá!")])]).toEqual([]);
		expect([...t.next([user("srv-1", "oi"), bot("srv-2", "Olá!")])]).toEqual([]);
	});
	it("mensagens antigas carregadas ao rolar para cima não animam", () => {
		const t = createNewItemTracker();
		t.next([user("c", "agora")]);
		const older = Array.from({ length: 30 }, (_, i) => user(`old-${i}`, `antiga ${i}`));
		expect([...t.next([...older, user("c", "agora")])]).toEqual([]);
	});
	it("mesma frase mandada de novo anima (não é troca de versão)", () => {
		const t = createNewItemTracker();
		t.next([user("a", "oi")]);
		expect([...t.next([user("a", "oi"), user("b", "oi")])]).toEqual(["b"]);
	});
});
