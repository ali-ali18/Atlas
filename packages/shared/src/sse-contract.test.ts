import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_EVENT_TYPES, RUN_TERMINAL_EVENTS } from "./sse-contract.js";

const root = join(__dirname, "..", "..", "..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sourceFiles(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

describe("lista canônica de eventos SSE de run", () => {
	it("não tem duplicata e inclui os terminais", () => {
		expect(new Set(RUN_EVENT_TYPES).size).toBe(RUN_EVENT_TYPES.length);
		for (const key of RUN_TERMINAL_EVENTS) expect(RUN_EVENT_TYPES).toContain(key.split(":")[0]);
		expect(RUN_TERMINAL_EVENTS).toHaveLength(5);
	});

	// O tipo `ComputerUseEvent` já impede (no tsc) emitir fora da lista em `onEvent(...)`; esta varredura cobre
	// quem monta o evento por fora do tipo (ex.: SSE escrito direto pela api).
	it("o runtime e a api só emitem tipos da lista", () => {
		const emitted = new Map<string, string>();
		const pattern = /\b(?:onEvent|emit|emitEvent)\(\s*\{\s*type:\s*"([a-z_-]+)"/g;
		for (const dir of ["packages/agent-runtime/src", "apps/api/src", "apps/worker/src"]) {
			for (const file of sourceFiles(join(root, dir))) {
				for (const match of readFileSync(file, "utf8").matchAll(pattern)) emitted.set(match[1]!, file);
			}
		}
		expect(emitted.size).toBeGreaterThan(10);
		const known = new Set<string>(RUN_EVENT_TYPES);
		const unknown = [...emitted].filter(([type]) => !known.has(type));
		expect(unknown, "tipo emitido fora de RUN_EVENT_TYPES (adicione à lista e ao union ComputerUseEvent)").toEqual([]);
	});
});
