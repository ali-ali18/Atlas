import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRootVersion } from "./version.js";

describe("readRootVersion", () => {
	it("acha o package.json raiz (name atlas) subindo a partir do app", () => {
		const root = mkdtempSync(join(tmpdir(), "atlas-ver-"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "atlas", version: "0.1.0-beta" }));
		const app = join(root, "apps", "api");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "package.json"), JSON.stringify({ name: "api", version: "9.9.9" }));
		expect(readRootVersion({}, app)).toBe("0.1.0-beta");
	});

	it("ATLAS_VERSION tem precedência e sem nada devolve vazio", () => {
		expect(readRootVersion({ ATLAS_VERSION: "1.2.3" }, "/")).toBe("1.2.3");
		expect(readRootVersion({}, mkdtempSync(join(tmpdir(), "atlas-none-")))).toBe("");
	});
});
