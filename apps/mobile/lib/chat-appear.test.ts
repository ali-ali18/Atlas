import { describe, expect, it } from "vitest";
import type { ChatItem } from "@/lib/chat-types";
import { createNewItemTracker } from "./chat-appear";

const user = (id: string, text: string): ChatItem => ({ id, kind: "user", text, createdAt: "2026-11-02T00:00:00Z" });
const bot = (id: string, text: string): ChatItem => ({ id, kind: "assistant", text, createdAt: "2026-11-02T00:00:00Z" });

describe("createNewItemTracker", () => {
	it("a primeira lista não anima; o que chega depois anima uma vez só", () => {
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
});
