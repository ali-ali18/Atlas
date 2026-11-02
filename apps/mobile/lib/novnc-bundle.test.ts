import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOVNC_BUNDLE, NOVNC_BUNDLE_SHA256, NOVNC_INPUTS_HASH, NOVNC_VERSION } from "./novnc-bundle.generated";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const HINT = "Rode `pnpm --filter @workspace/mobile build:novnc` e commite lib/novnc-bundle.generated.ts.";

describe("bundle do noVNC (arquivo gerado)", () => {
	const installed = (JSON.parse(readFileSync(path.join(root, "node_modules/@novnc/novnc/package.json"), "utf8")) as { version: string }).version;
	it(`está na versão do pacote instalado. ${HINT}`, () => {
		expect(NOVNC_VERSION).toBe(installed);
	});
	it(`está em dia com o pacote e com o script de build. ${HINT}`, () => {
		const script = readFileSync(path.join(root, "scripts/build-novnc-bundle.mjs"), "utf8");
		expect(NOVNC_INPUTS_HASH).toBe(sha256(`${installed}\n${script}`));
	});
	it("o conteúdo bate com o hash gravado (arquivo não foi editado à mão)", () => {
		expect(NOVNC_BUNDLE_SHA256).toBe(sha256(NOVNC_BUNDLE));
	});
	it("a versão do package.json do app é a exata (sem ^), para o bundle não divergir do que o lockfile instala", () => {
		const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
		expect(pkg.dependencies["@novnc/novnc"]).toBe(installed);
	});
	it("é um módulo que expõe window.NoVNC e não tem </script", () => {
		expect(NOVNC_BUNDLE).toContain("window.NoVNC");
		expect(NOVNC_BUNDLE).not.toMatch(/<\/script/i);
		expect(NOVNC_BUNDLE.length).toBeGreaterThan(50_000);
	});
	it("traz o aviso da licença MPL-2.0 e o NOTICE existe", () => {
		expect(NOVNC_BUNDLE.startsWith("/* noVNC")).toBe(true);
		expect(NOVNC_BUNDLE).toContain("MPL-2.0");
		expect(readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("MPL-2.0");
	});
});
