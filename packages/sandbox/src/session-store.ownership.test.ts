import { describe, expect, it } from "vitest";
import { putSession, getSession, deleteSession, findByConversationId, touchSession, listSessions } from "./session-store.js";
import type { SandboxSessionRecord } from "./types.js";

describe("store: posse da sessão", () => {
	it("outro dono não lê, encontra, renova nem apaga", () => {
		const record: SandboxSessionRecord = { userId: "owner-a", sessionId: "owned-store", conversationId: "conversation-store", containerId: "id", containerName: "name", status: "running", viewerPort: 1, controlPort: 2, createdAt: new Date(0), lastUsedAt: new Date(0) };
		putSession(record);
		expect(getSession(record.sessionId, "owner-b")).toBeUndefined();
		expect(listSessions("owner-b")).toEqual([]);
		expect(listSessions("owner-a")).toContain(record);
		expect(findByConversationId(record.conversationId!, "owner-b")).toBeUndefined();
		touchSession(record.sessionId, "owner-b");
		expect(record.lastUsedAt.getTime()).toBe(0);
		expect(deleteSession(record.sessionId, "owner-b")).toBe(false);
		expect(getSession(record.sessionId, "owner-a")).toBe(record);
		expect(() => putSession({ ...record, userId: "owner-b" })).toThrow("mismatch");
		expect(() => putSession({ ...record, userId: "default" })).toThrow("required");
		deleteSession(record.sessionId, "owner-a");
	});
});
