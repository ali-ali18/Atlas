import type { MemoryEntry } from "@workspace/shared";

export const BOT_CHARS_FOR_TEST = 2200;

export function entry(id: string, content: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id,
		target: "memory",
		content,
		category: null,
		confidence: null,
		importance: 0,
		source: null,
		validUntil: null,
		access: "private",
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		...over,
	};
}
