#!/usr/bin/env node
// Changelog do release: agrupa os commits (Conventional Commits) desde a tag anterior, em pt-BR.
// Uso: node scripts/changelog.mjs --to v0.1.0-beta [--from v0.0.1]   (sem --from, usa a tag anterior a --to)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SECTIONS = [
	["feat", "Novidades"],
	["fix", "Correções"],
	["perf", "Desempenho"],
	["refactor", "Refatorações"],
	["test", "Testes"],
	["ci", "CI"],
	["build", "Build"],
	["docs", "Documentação"],
	["style", "Estilo"],
	["chore", "Manutenção"],
];
const OTHER = "Outras mudanças";
const HEADER = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

/** `subjects`: assuntos (primeira linha) dos commits, do mais novo ao mais antigo. */
export function renderChangelog(subjects, { title } = {}) {
	const groups = new Map();
	for (const subject of subjects) {
		const text = subject.trim();
		if (!text || /^Merge /.test(text)) continue;
		const match = HEADER.exec(text);
		const known = match && SECTIONS.find(([type]) => type === match[1]);
		const label = known ? known[1] : OTHER;
		const line = match && known ? `${match[2] ? `**${match[2]}:** ` : ""}${match[4]}${match[3] ? " (mudança incompatível)" : ""}` : text;
		if (!groups.has(label)) groups.set(label, []);
		groups.get(label).push(line);
	}
	const order = [...SECTIONS.map(([, label]) => label), OTHER];
	const out = title ? [`## ${title}`, ""] : [];
	for (const label of order) {
		const lines = groups.get(label);
		if (!lines?.length) continue;
		out.push(`### ${label}`, ...lines.map((line) => `- ${line}`), "");
	}
	if (out.length === (title ? 2 : 0)) out.push("Sem mudanças registradas.", "");
	return out.join("\n");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function previousTag(to) {
	const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
	const index = tags.indexOf(to);
	return (index >= 0 ? tags[index + 1] : tags.find((tag) => tag !== to)) ?? null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const arg = (name) => {
		const i = process.argv.indexOf(`--${name}`);
		return i >= 0 ? process.argv[i + 1] : undefined;
	};
	const to = arg("to") ?? "HEAD";
	const from = arg("from") ?? (to === "HEAD" ? null : previousTag(to));
	const range = from ? `${from}..${to}` : to;
	const subjects = git("log", range, "--no-merges", "--format=%s").split("\n").filter(Boolean);
	process.stdout.write(renderChangelog(subjects, { title: from ? `${to} (desde ${from})` : to }));
}
