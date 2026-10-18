export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

export type DiffLine = { kind: DiffLineKind; text: string };

/** Classifica as linhas de um diff unificado para colorir (sem tocar no texto). */
export function parseDiffLines(diff: string): DiffLine[] {
	return diff.split("\n").map((text): DiffLine => {
		if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) {
			return { kind: "meta", text };
		}
		if (text.startsWith("@@")) return { kind: "hunk", text };
		if (text.startsWith("+")) return { kind: "add", text };
		if (text.startsWith("-")) return { kind: "remove", text };
		return { kind: "context", text };
	});
}
