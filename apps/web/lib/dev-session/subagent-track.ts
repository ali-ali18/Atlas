/**
 * Tempo e ferramentas dos subagentes. Os eventos `subagent_*` não trazem
 * horário: usamos o instante em que o cliente os recebeu (ou o `createdAt`
 * do evento persistido, quando houver).
 */

export type SubagentTrack = {
	startedAt: number;
	endedAt?: number;
	/** Ferramentas na ordem de uso, com contagem. */
	tools: { name: string; count: number; failed: number }[];
	lastTool?: string;
};

export type SubagentTrackMap = Readonly<Record<string, SubagentTrack>>;

export type SubagentTrackEvent =
	| { type: "subagent_started"; groupId: string; taskIndex: number }
	| { type: "subagent_tool"; groupId: string; taskIndex: number; name: string; ok: boolean }
	| { type: "subagent_done"; groupId: string; taskIndex: number };

export function subagentKey(groupId: string, taskIndex: number): string {
	return `${groupId}:${taskIndex}`;
}

/** Idempotente no que importa: o início só vale na primeira vez; o fim, na primeira vez. */
export function applySubagentTrack(map: SubagentTrackMap, event: SubagentTrackEvent, at: number): SubagentTrackMap {
	const key = subagentKey(event.groupId, event.taskIndex);
	const current: SubagentTrack = map[key] ?? { startedAt: at, tools: [] };
	let next = current;
	if (event.type === "subagent_tool") {
		const existing = current.tools.find((tool) => tool.name === event.name);
		const tools = existing
			? current.tools.map((tool) =>
					tool.name === event.name
						? { ...tool, count: tool.count + 1, failed: tool.failed + (event.ok ? 0 : 1) }
						: tool,
				)
			: [...current.tools, { name: event.name, count: 1, failed: event.ok ? 0 : 1 }];
		next = { ...current, tools, lastTool: event.name };
	} else if (event.type === "subagent_done" && current.endedAt === undefined) {
		next = { ...current, endedAt: at };
	}
	if (next === map[key]) return map;
	return { ...map, [key]: next };
}

export function subagentElapsedMs(track: SubagentTrack | undefined, running: boolean, now: number): number | null {
	if (!track) return null;
	const end = running || track.endedAt === undefined ? now : track.endedAt;
	return Math.max(0, end - track.startedAt);
}
