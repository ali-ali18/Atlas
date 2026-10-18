import type { ComputerUseEvent } from "./computer.js";

export function parseSseBlock(part: string): {
	id?: number;
	event?: ComputerUseEvent;
} {
	let id: number | undefined;
	const dataLines: string[] = [];
	for (const raw of part.split("\n")) {
		const row = raw.trim();
		if (row.startsWith("id:")) {
			const parsed = Number.parseInt(row.slice(3).trim(), 10);
			if (Number.isFinite(parsed)) id = parsed;
		} else if (row.startsWith("data:")) {
			dataLines.push(row.slice(5).trim());
		}
		// event:/retry:/: ping ignorados — cursor é o id, payload é data.
	}
	if (dataLines.length === 0) return { id };
	try {
		return { id, event: JSON.parse(dataLines.join("\n")) as ComputerUseEvent };
	} catch {
		return { id };
	}
}
