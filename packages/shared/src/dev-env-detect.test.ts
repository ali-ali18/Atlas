import { describe, expect, it } from "vitest";
import { detectDevEnvironment } from "./dev-env-detect.js";
import { parseEnvPaste } from "./dev-env-secrets-paste.js";

const pkg = (value: unknown) => JSON.stringify(value);
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

describe("detectDevEnvironment", () => {
	it("pnpm monorepo com turbo", () => {
		const s = detectDevEnvironment({
			rootFiles: ["package.json", "pnpm-lock.yaml", "turbo.json", "pnpm-workspace.yaml"],
			texts: { "package.json": pkg({ packageManager: "pnpm@9.1.0", scripts: { dev: "turbo dev", test: "x", lint: "x", typecheck: "x", build: "x" } }) },
		});
		expect(s.packageManager).toBe("pnpm");
		expect(s.installCommand).toBe("pnpm install --frozen-lockfile");
		expect(s.startCommand).toBe("pnpm dev");
		expect(s.tier).toBe("medium");
		expect(s.monorepo).toBe(true);
		expect(s.commandAllowlist).toContain("pnpm test");
		expect(s.commandAllowlist).toContain("pnpm run lint");
		expect(s.commandAllowlist.some((c) => c.startsWith("npm") || c.startsWith("yarn"))).toBe(false);
	});
	it("npm com lock, só scripts presentes, sem dev", () => {
		const s = detectDevEnvironment({ rootFiles: ["package.json", "package-lock.json"], texts: { "package.json": pkg({ scripts: { test: "x" } }) } });
		expect(s.installCommand).toBe("npm ci");
		expect(s.startCommand).toBeNull();
		expect(s.tier).toBe("small");
		expect(s.commandAllowlist).toContain("npm test");
		expect(s.commandAllowlist).not.toContain("npm run build");
	});
	it("yarn clássico e berry, bun", () => {
		expect(detectDevEnvironment({ rootFiles: ["yarn.lock"], texts: { "package.json": pkg({}) } }).installCommand).toBe("yarn install --frozen-lockfile");
		expect(detectDevEnvironment({ rootFiles: ["yarn.lock"], texts: { "package.json": pkg({ packageManager: "yarn@4.1.0" }) } }).installCommand).toBe("yarn install --immutable");
		const bun = detectDevEnvironment({ rootFiles: ["bun.lockb"], texts: { "package.json": pkg({ scripts: { dev: "x" } }) } });
		expect(bun.installCommand).toBe("bun install --frozen-lockfile");
		expect(bun.startCommand).toBe("bun run dev");
	});
	it("Next vira médio", () => {
		expect(detectDevEnvironment({ rootFiles: ["package.json"], texts: { "package.json": pkg({ dependencies: { next: "15" } }) } }).tier).toBe("medium");
	});
	it("python: requirements, poetry, uv", () => {
		expect(detectDevEnvironment({ rootFiles: [], texts: { "requirements.txt": "pytest" + LF } }).installCommand).toBe("pip install -r requirements.txt");
		expect(detectDevEnvironment({ rootFiles: [], texts: { "pyproject.toml": "[tool.poetry]" + LF + "name='a'" } }).installCommand).toBe("poetry install");
		const uv = detectDevEnvironment({ rootFiles: ["uv.lock"], texts: { "pyproject.toml": "[project]" + LF + "dependencies=['pytest']" } });
		expect(uv.installCommand).toBe("uv sync");
		expect(uv.commandAllowlist).toContain("uv run pytest");
	});
	it("Makefile sozinho e nada", () => {
		expect(detectDevEnvironment({ rootFiles: [], texts: { Makefile: ["build:", " go build", "test:", " go test"].join(LF) } }).commandAllowlist).toContain("make test");
		expect(detectDevEnvironment({ rootFiles: ["README.md"], texts: {} }).detected).toBe(false);
	});
	it("package.json quebrado não explode", () => {
		expect(detectDevEnvironment({ rootFiles: [], texts: { "package.json": "{oops" } }).detected).toBe(false);
	});
});

describe("parseEnvPaste", () => {
	it("comentários, export, aspas, '=' no valor, CRLF", () => {
		const text = ["# c", "", "export A=1", 'B="x y" # n', "C='q'", "D=a=b=c", "E=v"].join(CRLF);
		const r = parseEnvPaste(text);
		expect(r.errors).toEqual([]);
		expect(r.entries.map((e) => [e.name, e.value])).toEqual([["A", "1"], ["B", "x y"], ["C", "q"], ["D", "a=b=c"], ["E", "v"]]);
	});
	it("erros por linha", () => {
		const r = parseEnvPaste(["OK=1", "semigual", "1BAD=x", "BA-D=y", "EMPTY=", "PATH=x"].join(LF));
		expect(r.entries).toHaveLength(1);
		expect(r.empty).toEqual(["EMPTY"]);
		expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 6]);
		expect(r.errors[0]!.message).toBe("linha 2: falta '='");
	});
	it("duplicado: o último vale", () => {
		const r = parseEnvPaste(["A=1", "B=2", "A=3"].join(LF));
		expect(r.entries.map((e) => [e.name, e.value])).toEqual([["B", "2"], ["A", "3"]]);
	});
});

describe("testCommand sugerido", () => {
	it("projeto simples usa o script test; monorepo não sugere a suíte inteira", () => {
		const single = detectDevEnvironment({ rootFiles: ["package.json", "pnpm-lock.yaml"], texts: { "package.json": pkg({ scripts: { test: "vitest" } }) } });
		expect(single.testCommand).toBe("pnpm test");
		expect(detectDevEnvironment({ rootFiles: ["package.json", "package-lock.json"], texts: { "package.json": pkg({ scripts: { test: "x" } }) } }).testCommand).toBe("npm test");
		const mono = detectDevEnvironment({ rootFiles: ["package.json", "pnpm-workspace.yaml"], texts: { "package.json": pkg({ scripts: { test: "turbo test" } }) } });
		expect(mono.testCommand).toBeNull();
		expect(detectDevEnvironment({ rootFiles: ["package.json"], texts: { "package.json": pkg({ scripts: { dev: "x" } }) } }).testCommand).toBeNull();
	});
	it("python e make", () => {
		expect(detectDevEnvironment({ rootFiles: ["uv.lock"], texts: { "pyproject.toml": "[tool.uv]\n[tool.pytest]\npytest" } }).testCommand).toBe("uv run pytest");
		expect(detectDevEnvironment({ rootFiles: [], texts: { Makefile: ["test:", " go test ./..."].join(LF) } }).testCommand).toBe("make test");
	});
});
