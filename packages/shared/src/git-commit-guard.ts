// O que nunca vai num commit do agente (D3 da auditoria F9): arquivo de segredo (.env, chave, credencial) e caminho que muda o
// que RODA no GitHub ou na máquina do dono (workflow do CI, hooks do git). Puro: decide só pelo caminho. Complementa
// `isSensitiveEnvFile` (lido pelo portão de comandos) com as chaves e credenciais que a lista curta deixava passar.
import { isSensitiveEnvFile } from "./dev-command-approval.js";

/** `git diff --name-only` imprime nome com acento entre aspas e escapes octais (`"d\303\251/.env"`) quando `core.quotePath` está ligado. */
function unquoteGitPath(raw: string): string {
	const text = raw.trim();
	if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text;
	const bytes: number[] = [];
	const inner = text.slice(1, -1);
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (ch !== "\\") {
			bytes.push(...Buffer.from(ch, "utf8"));
			continue;
		}
		const next = inner[i + 1] ?? "";
		if (/[0-7]/.test(next)) {
			const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))![0];
			bytes.push(Number.parseInt(octal, 8) & 0xff);
			i += octal.length;
			continue;
		}
		const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92 };
		bytes.push(simple[next] ?? next.charCodeAt(0));
		i += 1;
	}
	return Buffer.from(bytes).toString("utf8");
}

const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".tfstate", ".tfvars"];
const SECRET_NAMES = new Set(["credentials.json", ".pypirc", ".htpasswd", ".pgpass", "kubeconfig", "secrets.json"]);

/** Arquivo que costuma guardar segredo: .env e afins (`isSensitiveEnvFile`), chaves, keystores, credenciais de nuvem e de registro. */
export function isSensitiveCommitFile(path: string): boolean {
	const clean = unquoteGitPath(path).replace(/\\/g, "/");
	if (isSensitiveEnvFile(clean)) return true;
	const lower = clean.toLowerCase();
	const name = lower.split("/").pop() ?? "";
	if (SECRET_NAMES.has(name)) return true;
	if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length)) return true;
	if (/^service-?account[^/]*\.json$/.test(name)) return true;
	return lower === ".docker/config.json" || lower.endsWith("/.docker/config.json") || lower === ".kube/config" || lower.endsWith("/.kube/config");
}

/** Caminho que decide o que roda sozinho (CI do GitHub, hooks do git): só o dono mexe, à mão. */
export function isGuardedCommitPath(path: string): boolean {
	const lower = unquoteGitPath(path).replace(/\\/g, "/").toLowerCase();
	if (lower.startsWith(".github/workflows/") || lower.startsWith(".github/actions/")) return true;
	return lower.split("/").some((segment) => segment === ".husky" || segment === ".githooks");
}

/** Separa a lista de arquivos de um commit (ou de vários) em segredos e caminhos guardados. Os nomes voltam já sem aspas. */
export function classifyCommitPaths(paths: readonly string[]): { secrets: string[]; guarded: string[] } {
	const secrets: string[] = [];
	const guarded: string[] = [];
	for (const raw of paths) {
		const path = unquoteGitPath(raw);
		if (!path) continue;
		if (isSensitiveCommitFile(path)) secrets.push(path);
		else if (isGuardedCommitPath(path)) guarded.push(path);
	}
	return { secrets, guarded };
}
