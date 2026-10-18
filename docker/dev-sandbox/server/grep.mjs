import { execFile } from "node:child_process";
import { confinePath, WORKSPACE } from "./path-guard.mjs";
import { capTail, RETURN_CAP_BYTES } from "./output-buffer.mjs";

// Busca com ripgrep (argv, sem shell: o padrão nunca é interpretado pelo bash).

export const GREP_MAX_RESULTS = 200;
const GREP_TIMEOUT_MS = 20_000;

export class GrepError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "GrepError";
		this.status = status;
	}
}

export function buildRgArgs({ pattern, glob, ignoreCase, fixed, maxResults }) {
	if (typeof pattern !== "string" || !pattern) throw new GrepError("pattern obrigatório");
	if (pattern.length > 2_000) throw new GrepError("pattern grande demais");
	const args = ["--line-number", "--no-heading", "--color=never", "--max-columns=300", "--max-columns-preview", "--max-count=50", "--hidden", "-g", "!.git"];
	if (ignoreCase) args.push("-i");
	if (fixed) args.push("-F");
	if (typeof glob === "string" && glob.trim()) args.push("-g", glob.trim());
	args.push("-e", pattern, "--");
	return { args, maxResults: Math.min(GREP_MAX_RESULTS, Math.max(1, Math.floor(Number(maxResults)) || 100)) };
}

export function createGrepApi(options = {}) {
	const workspace = options.workspace ?? WORKSPACE;
	const run = options.execFile ?? execFile;
	const confine = options.confine ?? ((p) => confinePath(p, { base: workspace }));

	return {
		async search(input) {
			const root = await confine(input.path ?? workspace);
			const { args, maxResults } = buildRgArgs(input);
			const stdout = await new Promise((resolve, reject) => {
				run("rg", [...args, root], { timeout: GREP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, cwd: workspace }, (error, out, err) => {
					// rg sai com 1 quando não há resultado: não é erro.
					if (error && error.code !== 1 && !out) {
						reject(new GrepError(String(err || error.message).slice(0, 500), error.code === "ENOENT" ? 500 : 400));
						return;
					}
					resolve(String(out ?? ""));
				});
			});
			const lines = stdout.split("\n").filter(Boolean);
			const shown = lines.slice(0, maxResults);
			const capped = capTail(shown.join("\n"), RETURN_CAP_BYTES);
			return { matches: capped.text, count: shown.length, totalFound: lines.length, truncated: lines.length > shown.length || capped.truncated };
		},
	};
}
