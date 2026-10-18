import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EnvLike } from "@workspace/shared";

/**
 * Versão do projeto: `version` do package.json RAIZ (o de nome "atlas"), procurado a partir do
 * diretório atual para cima (funciona no monorepo e na imagem, onde o package.json da raiz fica em /app).
 * `ATLAS_VERSION` no ambiente tem precedência. Sem nada, devolve "".
 */
export function readRootVersion(env: EnvLike = process.env, startDir: string = process.cwd()): string {
	const fromEnv = env.ATLAS_VERSION?.trim();
	if (fromEnv) return fromEnv;
	let dir = startDir;
	for (let depth = 0; depth < 6; depth += 1) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			try {
				const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
				if (pkg.name === "atlas") return pkg.version ?? "";
			} catch {
				// segue subindo
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "";
}
