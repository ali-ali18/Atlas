import { describe, expect, it } from "vitest";
import { applyMatches, findMatches } from "./code-edit-match.js";

// O porte em TS (usado só pelo fake) tem de casar com o da VM (`docker/dev-sandbox/server/edit-match.mjs`), caso a caso.
// @ts-expect-error o .mjs da imagem não tem tipos; só este teste o importa.
const vm = (await import("../../../../docker/dev-sandbox/server/edit-match.mjs")) as { findMatches: typeof findMatches; applyMatches: typeof applyMatches };

const CASES: Array<{ name: string; text: string; old: string; new: string }> = [
	{ name: "exato único", text: "a\nb\nc\n", old: "b", new: "B" },
	{ name: "exato repetido", text: "x\nx\nx\n", old: "x", new: "y" },
	{ name: "CRLF no arquivo, LF no old", text: "if (a) {\r\n\treturn 1;\r\n}\r\n", old: "if (a) {\n\treturn 1;\n}", new: "if (a) {\n\treturn 2;\n}" },
	{ name: "espaço no fim da linha", text: "const a = 1;   \nconst b = 2;\n", old: "const a = 1;\nconst b = 2;", new: "const a = 3;\nconst b = 2;" },
	{ name: "indentação errada", text: "class A {\n    run() {\n        return 1;\n    }\n}\n", old: "run() {\n    return 1;\n}", new: "run() {\n    return 2;\n}" },
	{ name: "linha única em arquivo CRLF crescendo", text: "a\r\nb\r\n", old: "a", new: "a\nc" },
	{ name: "sem casamento", text: "abc\n", old: "zzz", new: "y" },
	{ name: "ambíguo por indentação", text: "  f();\n\tf();\n", old: "f();", new: "g();" },
];

describe("porte do casamento de edição ≡ o da VM", () => {
	for (const c of CASES) {
		it(c.name, () => {
			const mine = findMatches(c.text, c.old, c.new);
			const theirs = vm.findMatches(c.text, c.old, c.new);
			expect(mine).toEqual(theirs);
			expect(applyMatches(c.text, mine.matches)).toBe(vm.applyMatches(c.text, theirs.matches));
		});
	}
});
