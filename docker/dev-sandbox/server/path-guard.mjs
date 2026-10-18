import posix from "node:path/posix";

// Confinamento de caminhos da API de arquivos. O servidor roda como usuário
// não-root `dev`; ainda assim a API de arquivos só enxerga /workspace e /tmp
// (o shell do agente continua livre dentro do container, que é descartável).

export const WORKSPACE = process.env.DEV_WORKSPACE ?? "/workspace";
export const SANDBOX_HOME = process.env.DEV_USER_HOME ?? "/home/dev";
export const DEFAULT_ROOTS = [WORKSPACE, "/tmp"];
export const DENIED_PREFIXES = [];

export class PathError extends Error {
	constructor(message) {
		super(message);
		this.name = "PathError";
		this.status = 403;
	}
}

function within(path, root) {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Expande `~`, resolve relativo a `base` (padrão /workspace) e normaliza `..`. */
export function resolveInput(input, base = WORKSPACE, home = SANDBOX_HOME) {
	if (typeof input !== "string" || !input.trim()) throw new PathError("path vazio");
	if (input.includes("\0")) throw new PathError("path inválido");
	const raw = input.trim();
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? posix.join(home, raw.slice(2)) : raw;
	return posix.resolve(base, expanded);
}

/**
 * Devolve o caminho absoluto confinado ou lança PathError.
 * `realpath` (opcional, async) resolve symlinks do ancestral existente mais
 * profundo, para um link dentro de /workspace não escapar para /etc.
 */
export async function confinePath(input, options = {}) {
	const roots = options.roots ?? DEFAULT_ROOTS;
	const denied = options.denied ?? DENIED_PREFIXES;
	const abs = resolveInput(input, options.base ?? WORKSPACE, options.home ?? SANDBOX_HOME);
	check(abs, roots, denied);
	if (options.realpath) {
		let probe = abs;
		for (;;) {
			let real;
			try {
				real = await options.realpath(probe);
			} catch {
				const parent = posix.dirname(probe);
				if (parent === probe) break;
				probe = parent;
				continue;
			}
			const full = probe === abs ? real : posix.join(real, posix.relative(probe, abs));
			// /tmp pode ser link em alguns sistemas: raízes também passam por realpath.
			const realRoots = await Promise.all(roots.map((r) => options.realpath(r).catch(() => r)));
			check(full, [...roots, ...realRoots], denied);
			break;
		}
	}
	return abs;
}

function check(abs, roots, denied) {
	if (!roots.some((root) => within(abs, root))) {
		throw new PathError(`Caminho fora da área permitida (${roots.join(", ")}): ${abs}`);
	}
	if (denied.some((prefix) => within(abs, prefix))) {
		throw new PathError(`Caminho protegido: ${abs}`);
	}
}
