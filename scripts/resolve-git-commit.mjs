// Descobre o commit do checkout lendo o .git direto (HEAD -> ref -> packed-refs), sem o binário git.
// Uso no build: node scripts/resolve-git-commit.mjs <diretório .git> <arquivo de saída>
// Sem .git (ou ilegível) grava arquivo vazio: a UI mostra só a versão.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HASH = /^[0-9a-f]{40}$/i;

function readText(file) {
	try {
		return existsSync(file) ? readFileSync(file, "utf8") : "";
	} catch {
		return "";
	}
}

/** Hash de 40 caracteres do HEAD, ou "" se não der para resolver. */
export function resolveGitCommit(gitDir) {
	const head = readText(join(gitDir, "HEAD")).trim();
	if (!head) return "";
	if (HASH.test(head)) return head.toLowerCase();
	const match = /^ref:\s*(\S+)/.exec(head);
	if (!match) return "";
	const ref = match[1];
	const loose = readText(join(gitDir, ref)).trim();
	if (HASH.test(loose)) return loose.toLowerCase();
	for (const line of readText(join(gitDir, "packed-refs")).split(/\r?\n/)) {
		if (!line || line.startsWith("#") || line.startsWith("^")) continue;
		const [hash, name] = line.trim().split(/\s+/);
		if (name === ref && HASH.test(hash ?? "")) return hash.toLowerCase();
	}
	return "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [gitDir = ".git", out = ".atlas-commit"] = process.argv.slice(2);
	const commit = resolveGitCommit(gitDir);
	writeFileSync(out, commit);
	console.log(commit ? `commit: ${commit.slice(0, 7)}` : "commit: não encontrado (só a versão será exibida)");
}
