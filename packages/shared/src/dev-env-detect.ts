/**
 * Detecção do ambiente de código a partir de arquivos do repositório (puro:
 * nomes da raiz + conteúdo de poucos arquivos de texto → sugestões). Sem regex.
 */

import type { DevEnvTier } from "./dev-environment.js";

export type RepoProbe = {
	/** Nomes dos arquivos/pastas na raiz do repositório. */
	rootFiles: readonly string[];
	/** Conteúdo (texto) dos arquivos lidos: package.json, pyproject.toml, requirements.txt, Makefile, .nvmrc. */
	texts: Readonly<Record<string, string | undefined>>;
};

export type DetectedPackageManager = "pnpm" | "npm" | "yarn" | "bun" | "pip" | "poetry" | "uv";

export type DevEnvSuggestion = {
	detected: boolean;
	packageManager: DetectedPackageManager | null;
	installCommand: string | null;
	startCommand: string | null;
	/** Teste rápido sugerido (nunca a suíte do monorepo inteiro). */
	testCommand: string | null;
	tier: DevEnvTier;
	commandAllowlist: string[];
	monorepo: boolean;
};

/** Arquivos que a detecção lê (conteúdo). */
export const DETECT_TEXT_FILES = ["package.json", "pyproject.toml", "requirements.txt", "Makefile", ".nvmrc"] as const;

const NL = String.fromCharCode(10);
const GIT_DEFAULTS = ["git add", "git commit", "git switch", "git fetch"];
const SCRIPT_NAMES = ["test", "lint", "typecheck", "type-check", "build"];
const HEAVY_DEPS = ["next", "nuxt", "@angular/core", "@nestjs/core", "react-native", "expo", "gatsby", "@remix-run/react", "electron"];

type NodePm = "pnpm" | "npm" | "yarn" | "bun";

function parseJson(text: string | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nodeManager(pkg: Record<string, unknown>, files: ReadonlySet<string>): { pm: NodePm; hasLock: boolean; yarnBerry: boolean } {
	const field = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
	const [fieldName = "", fieldVersion = ""] = field.split("@");
	const lock: Record<NodePm, boolean> = {
		pnpm: files.has("pnpm-lock.yaml"),
		npm: files.has("package-lock.json") || files.has("npm-shrinkwrap.json"),
		yarn: files.has("yarn.lock"),
		bun: files.has("bun.lockb") || files.has("bun.lock"),
	};
	let pm: NodePm | null = null;
	if (fieldName === "pnpm" || fieldName === "npm" || fieldName === "yarn" || fieldName === "bun") pm = fieldName;
	else if (lock.pnpm) pm = "pnpm";
	else if (lock.bun) pm = "bun";
	else if (lock.yarn) pm = "yarn";
	else if (lock.npm) pm = "npm";
	const chosen: NodePm = pm ?? "npm";
	const major = Number.parseInt(fieldVersion, 10);
	return { pm: chosen, hasLock: lock[chosen], yarnBerry: chosen === "yarn" && Number.isFinite(major) && major >= 2 };
}

function installFor(pm: NodePm, hasLock: boolean, berry: boolean): string {
	if (pm === "pnpm") return hasLock ? "pnpm install --frozen-lockfile" : "pnpm install";
	if (pm === "npm") return hasLock ? "npm ci" : "npm install";
	if (pm === "yarn") return hasLock ? (berry ? "yarn install --immutable" : "yarn install --frozen-lockfile") : "yarn install";
	return hasLock ? "bun install --frozen-lockfile" : "bun install";
}

function runPrefix(pm: NodePm, script: string): string[] {
	if (pm === "npm") return script === "test" ? ["npm test", "npm run test"] : [`npm run ${script}`];
	if (pm === "yarn") return script === "test" ? ["yarn test"] : [`yarn ${script}`];
	if (pm === "bun") return script === "test" ? ["bun test", "bun run test"] : [`bun run ${script}`];
	return script === "test" ? ["pnpm test", "pnpm run test"] : [`pnpm ${script}`, `pnpm run ${script}`];
}

function installAllow(pm: NodePm): string[] {
	return pm === "npm" ? ["npm install", "npm ci"] : [`${pm} install`];
}

function makeTargets(text: string | undefined): string[] {
	const out: string[] = [];
	for (const raw of (text ?? "").split(NL)) {
		const line = raw.trim();
		const colon = line.indexOf(":");
		if (colon <= 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq >= 0 && eq < colon) continue;
		const target = line.slice(0, colon).trim();
		if (["test", "lint", "build", "check", "typecheck"].includes(target) && !out.includes(target)) out.push(target);
	}
	return out;
}

function uniq(list: string[]): string[] {
	return list.filter((item, index) => list.indexOf(item) === index);
}

export function detectDevEnvironment(probe: RepoProbe): DevEnvSuggestion {
	const files = new Set(probe.rootFiles);
	const pkg = parseJson(probe.texts["package.json"]);
	const pyproject = probe.texts["pyproject.toml"];
	const requirements = probe.texts["requirements.txt"];
	const make = makeTargets(probe.texts["Makefile"]);
	const workspaces = pkg ? pkg.workspaces !== undefined : false;
	const monorepo = files.has("turbo.json") || files.has("pnpm-workspace.yaml") || files.has("nx.json") || files.has("lerna.json") || workspaces;
	const empty: DevEnvSuggestion = { detected: false, packageManager: null, installCommand: null, startCommand: null, testCommand: null, tier: "small", commandAllowlist: [], monorepo };

	if (pkg) {
		const { pm, hasLock, yarnBerry } = nodeManager(pkg, files);
		const scripts = asRecord(pkg.scripts);
		const allow: string[] = [...installAllow(pm)];
		for (const name of SCRIPT_NAMES) if (typeof scripts[name] === "string") allow.push(...runPrefix(pm, name));
		const deps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
		const heavy = HEAVY_DEPS.some((name) => name in deps) || Object.keys(deps).length > 80;
		const start = typeof scripts.dev === "string" ? (pm === "npm" || pm === "bun" ? `${pm} run dev` : `${pm} dev`) : null;
		return {
			detected: true,
			packageManager: pm,
			installCommand: installFor(pm, hasLock, yarnBerry),
			startCommand: start,
			// Em monorepo o `test` da raiz roda todos os pacotes: sem sugestão, o agente testa só o que mudou.
			testCommand: !monorepo && typeof scripts.test === "string" ? runPrefix(pm, "test")[0]! : null,
			tier: monorepo || heavy ? "medium" : "small",
			commandAllowlist: uniq([...allow, ...GIT_DEFAULTS]),
			monorepo,
		};
	}

	if (pyproject !== undefined || requirements !== undefined) {
		let pm: DetectedPackageManager = "pip";
		let install: string;
		if (files.has("uv.lock") || (pyproject ?? "").includes("[tool.uv]")) {
			pm = "uv";
			install = "uv sync";
		} else if ((pyproject ?? "").includes("[tool.poetry]")) {
			pm = "poetry";
			install = "poetry install";
		} else if (requirements !== undefined) {
			install = "pip install -r requirements.txt";
		} else {
			install = "pip install -e .";
		}
		const run = pm === "uv" ? "uv run " : pm === "poetry" ? "poetry run " : "";
		const allow: string[] = [pm === "uv" ? "uv sync" : pm === "poetry" ? "poetry install" : "pip install"];
		const blob = `${pyproject ?? ""}${NL}${requirements ?? ""}`;
		if (blob.includes("pytest")) allow.push(`${run}pytest`);
		if (blob.includes("ruff")) allow.push(`${run}ruff check`);
		for (const target of make) allow.push(`make ${target}`);
		const testCommand = blob.includes("pytest") ? `${run}pytest` : make.includes("test") ? "make test" : null;
		return { ...empty, detected: true, packageManager: pm, installCommand: install, testCommand, commandAllowlist: uniq([...allow, ...GIT_DEFAULTS]) };
	}

	if (make.length > 0) {
		return { ...empty, detected: true, testCommand: make.includes("test") ? "make test" : null, commandAllowlist: uniq([...make.map((target) => `make ${target}`), ...GIT_DEFAULTS]) };
	}
	return empty;
}
