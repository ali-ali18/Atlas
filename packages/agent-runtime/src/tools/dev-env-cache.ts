import type { DevSetupCacheState } from "@workspace/shared";
import { parseEnvCacheMeta, type EnvCacheAction, type EnvCacheMeta } from "@workspace/sandbox";

/**
 * Cache de dependências do ambiente (volume /envcache, por usuário + repositório).
 * Aqui ficam os scripts que rodam DENTRO do container e a leitura da sonda; a chave e a
 * decisão (hit/stale/rebuild/miss) vêm de `@workspace/sandbox` (env-cache.ts), que também
 * documenta o modelo de ameaça. Os scripts só tocam diretórios de dependência ignorados
 * pelo git: nenhum `.env` é arquivado.
 */

const LOCK_NAMES = [
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
	"bun.lockb",
	"bun.lock",
	"poetry.lock",
	"uv.lock",
	"Pipfile.lock",
	"Cargo.lock",
	"go.sum",
	"Gemfile.lock",
	"composer.lock",
	"requirements*.txt",
];

/** Sonda: o volume está montado e gravável? versão da imagem/node/arquitetura, hash dos lockfiles, metadados salvos. */
export const CACHE_PROBE_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 1',
	// Só vale se for um volume montado de verdade (o diretório existe na imagem, mas fora do volume some com o container).
	'if grep -q " /envcache " /proc/mounts && [ -w /envcache ]; then echo "writable=1"; else echo "writable=0"; fi',
	'echo "runtime=${DEV_IMAGE_VERSION:-0} $(node -v 2>/dev/null) $(uname -m)"',
	"LOCKS=$(find . -maxdepth 4 -name node_modules -prune -o -name .git -prune -o -type f -print0 | while IFS= read -r -d '' f; do",
	`  case "\${f##*/}" in ${LOCK_NAMES.join("|")}) echo "$f";; esac`,
	"done | sort)",
	'if [ -n "$LOCKS" ]; then echo "lock=$(echo "$LOCKS" | while IFS= read -r f; do echo "$f"; sha256sum < "$f"; done | sha256sum | cut -c1-32)"; else echo "lock=none"; fi',
	'echo "saved=$(cat /envcache/meta.json 2>/dev/null)"',
].join("\n");

/** Restaura as dependências salvas (só se o workspace ainda não tem node_modules na raiz). */
export const CACHE_RESTORE_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 1',
	'[ -e node_modules ] && { echo "(workspace já tem node_modules)"; exit 0; }',
	"[ -f /envcache/deps.tar ] || exit 3",
	'tar -xf /envcache/deps.tar -C "$DEV_REPO_DIR" || exit 4',
	"touch /envcache/.used",
].join("\n");

/** Descarta o conteúdo antigo (comando, imagem ou segredos mudaram). */
export const CACHE_WIPE_SCRIPT = "find /envcache -mindepth 1 -maxdepth 1 -exec rm -rf {} +";

/** Guarda node_modules/.venv ignorados pelo git. `DEV_CACHE_META` leva só a chave e hashes. */
export const CACHE_SAVE_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 1',
	"LIST=$(mktemp)",
	"find . -maxdepth 5 -name .git -prune -o -type d -name node_modules -prune -print0 -o -type d -name .venv -prune -print0 | while IFS= read -r -d '' d; do",
	'  git check-ignore -q "$d" && echo "$d" >> "$LIST"',
	"done",
	'if [ ! -s "$LIST" ]; then rm -f "$LIST"; echo "(nada para guardar)"; exit 0; fi',
	"TMP=/envcache/deps.tar.tmp",
	'if tar -cf "$TMP" -T "$LIST"; then mv -f "$TMP" /envcache/deps.tar && echo "$DEV_CACHE_META" > /envcache/meta.json && touch /envcache/.used; else rm -f "$TMP"; fi',
	'rm -f "$LIST"',
].join("\n");

export type CacheProbe = { writable: boolean; runtime: string; lockHash: string; saved: EnvCacheMeta | null };

export function parseCacheProbe(output: string): CacheProbe {
	const lines = output.split(String.fromCharCode(10));
	const read = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
	return {
		writable: read("writable=").trim() === "1",
		runtime: read("runtime=").trim(),
		lockHash: read("lock=").trim() || "none",
		saved: parseEnvCacheMeta(read("saved=")),
	};
}

export function cacheStateOf(action: EnvCacheAction): DevSetupCacheState | undefined {
	if (action === "off") return undefined;
	return action;
}

/** Nota para o modelo sobre como as dependências ficaram prontas. */
export function cacheNote(action: EnvCacheAction, installCommand: string): string {
	if (action === "hit") return `Dependências restauradas do cache do ambiente e conferidas com "${installCommand}".`;
	if (action === "stale") return `O lockfile mudou desde o último cache: dependências restauradas e atualizadas com "${installCommand}".`;
	if (action === "rebuild") return "O comando de instalação, a imagem ou os segredos mudaram: o cache antigo foi descartado e tudo foi reinstalado.";
	return "";
}
