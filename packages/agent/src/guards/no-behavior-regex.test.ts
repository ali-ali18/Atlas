import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Guarda "sem regex de comportamento" (60-agente; 05-fases, guardas permanentes #2).
//
// Regra: decisão de comportamento do agente usa sinal estrutural, nunca padrão sobre texto livre.
// Esta guarda lê o AST (compilador do TypeScript) de todo `.ts` que não é teste em `packages/agent/src`
// e `packages/shared/src/agent-policy` e falha quando uma operação de padrão/texto é aplicada a uma
// expressão cujo nome está na denylist de FONTES DE TEXTO LIVRE (objective, content, text, message...).
//
// Operações: literal RegExp, `new RegExp`, `.match/.matchAll/.search/.test/.exec/.includes/.startsWith/.endsWith`
// e `.replace/.replaceAll/.split` quando o padrão é um RegExp.
//
// Limites (análise conservadora, de propósito simples; ela pega o caso comum, não prova ausência):
// - olha o NOME: caminho `a.b.text`, `a?.text`, `a["text"]`, `text!`, `(text as X)`, e cadeias de
//   transformação de texto (`text.trim().toLowerCase().match(...)` conta como `text`);
// - segue UM nível de alias local no arquivo (`const t = msg.content; t.includes(...)`);
// - não segue valor que atravessa função, campo renomeado ou desestruturação com outro nome.
// Exceção: validação de FORMATO (id, nome, nonce, sanitização de caracteres), com o comentário
//   // guard-allow: format-validation <por quê>
// na mesma linha da operação ou na linha de cima. O "por quê" é obrigatório.

const AGENT_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = [AGENT_SRC, join(AGENT_SRC, "..", "..", "shared", "src", "agent-policy")];
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/** Nomes (último segmento do caminho) que carregam texto livre do dono, do modelo ou de terceiros. */
export const FREE_TEXT_NAMES: ReadonlySet<string> = new Set([
	"objective",
	"content",
	"text",
	"message",
	"messages",
	"userText",
	"ownerText",
	"assistantText",
	"lastText",
	"reply",
	"answer",
	"body",
	"prompt",
	"question",
	"summary",
	"transcript",
]);

/** Métodos de texto que são "padrão sobre texto" por si só. */
const TEXT_METHODS: ReadonlySet<string> = new Set(["match", "matchAll", "search", "includes", "startsWith", "endsWith"]);
/** Métodos de texto que só contam com um RegExp como padrão. */
const REGEX_ONLY_METHODS: ReadonlySet<string> = new Set(["replace", "replaceAll", "split"]);
/** Métodos de RegExp: o texto é o ARGUMENTO. */
const REGEX_METHODS: ReadonlySet<string> = new Set(["test", "exec"]);
/** Transformações que preservam "isto ainda é o texto livre". */
const PASS_THROUGH: ReadonlySet<string> = new Set(["trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "normalize", "slice", "substring", "at", "toString", "join"]);

const ALLOW = /\/\/\s*guard-allow:\s*format-validation\s+\S/;

export type Violation = { file: string; line: number; text: string; why: string };

function unwrap(node: ts.Node): ts.Node {
	let n = node;
	for (;;) {
		if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
		else return n;
	}
}

/** Nome da fonte de texto livre que a expressão representa, ou undefined. */
function freeTextName(node: ts.Node, aliases: ReadonlySet<string>): string | undefined {
	const n = unwrap(node);
	if (ts.isIdentifier(n)) return FREE_TEXT_NAMES.has(n.text) || aliases.has(n.text) ? n.text : undefined;
	if (ts.isPropertyAccessExpression(n)) return FREE_TEXT_NAMES.has(n.name.text) ? n.name.text : undefined;
	if (ts.isElementAccessExpression(n)) {
		const arg = unwrap(n.argumentExpression);
		return ts.isStringLiteralLike(arg) && FREE_TEXT_NAMES.has(arg.text) ? arg.text : undefined;
	}
	if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && PASS_THROUGH.has(n.expression.name.text)) return freeTextName(n.expression.expression, aliases);
	if (ts.isTemplateExpression(n)) return n.templateSpans.map((s) => freeTextName(s.expression, aliases)).find((x) => x !== undefined);
	return undefined;
}

const isRegexNode = (node: ts.Node): boolean => {
	const n = unwrap(node);
	return ts.isRegularExpressionLiteral(n) || (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "RegExp");
};

/** Analisa um arquivo. `code` é o texto-fonte; `file` só rotula o resultado. */
export function findViolations(code: string, file = "snippet.ts"): Violation[] {
	const source = ts.createSourceFile(file, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
	const lines = code.split("\n");
	const found: Violation[] = [];

	// Aliases de um nível: `const t = <fonte de texto livre>`.
	const aliases = new Set<string>();
	const collectAliases = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && freeTextName(node.initializer, new Set()) !== undefined) aliases.add(node.name.text);
		ts.forEachChild(node, collectAliases);
	};
	collectAliases(source);

	const allowed = (line0: number) => ALLOW.test(lines[line0] ?? "") || ALLOW.test(lines[line0 - 1] ?? "");
	const report = (node: ts.Node, why: string) => {
		const line0 = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
		if (allowed(line0)) return;
		found.push({ file, line: line0 + 1, text: (lines[line0] ?? "").trim(), why });
	};

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const receiver = node.expression.expression;
			const first = node.arguments[0];
			if (TEXT_METHODS.has(method)) {
				const name = freeTextName(receiver, aliases);
				if (name) report(node, `.${method}() sobre texto livre "${name}"`);
			} else if (REGEX_ONLY_METHODS.has(method) && first && isRegexNode(first)) {
				const name = freeTextName(receiver, aliases);
				if (name) report(node, `.${method}(RegExp) sobre texto livre "${name}"`);
			} else if (REGEX_METHODS.has(method) && first) {
				const name = freeTextName(first, aliases);
				if (name) report(node, `RegExp .${method}() sobre texto livre "${name}"`);
			}
			// `texto.match(/re/)` com o argumento sendo a fonte (ex.: `/re/.test(text)` já coberto acima).
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function listSources(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		if (SKIP_DIRS.has(name)) return [];
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return listSources(full);
		return full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts") ? [full] : [];
	});
}

describe("guarda: sem regex de comportamento (AST)", () => {
	it("nenhum arquivo do motor aplica padrão a texto livre sem exceção declarada", () => {
		const files = SCAN_ROOTS.flatMap(listSources);
		expect(files.length).toBeGreaterThan(30); // a varredura enxerga o pacote de verdade
		const all = files.flatMap((f) => findViolations(readFileSync(f, "utf8"), relative(AGENT_SRC, f)));
		const report = all.map((v) => `${v.file}:${v.line}  ${v.why}\n    ${v.text}`).join("\n");
		expect(all, `Regex/includes sobre texto livre decide comportamento? Use sinal estrutural (60-agente). Validação de formato: acrescente "// guard-allow: format-validation <por quê>".\n${report}`).toEqual([]);
	});

	it("cobre as duas raízes (agent/src e shared/agent-policy)", () => {
		expect(SCAN_ROOTS.flatMap(listSources).some((f) => f.includes("agent-policy"))).toBe(true);
	});
});

describe("guarda: auto-testes da análise", () => {
	const bad = (code: string) => findViolations(code).length;

	it("pega os usos proibidos", () => {
		expect(bad("const stop = /continua/i.test(message.content);")).toBe(1);
		expect(bad("if (userText.includes('compare')) go();")).toBe(1);
		expect(bad("if (state.objective.startsWith('pesquise')) go();")).toBe(1);
		expect(bad("const m = assistantText.trim().toLowerCase().match(/vou pedir/);")).toBe(1);
		expect(bad("const r = reply?.search(new RegExp('x'));")).toBe(1);
		expect(bad("x = (answer as string).endsWith('?');")).toBe(1);
		expect(bad("x = msg['body'].includes('a');")).toBe(1);
		expect(bad("const t = req.text; if (t.includes('a')) go();")).toBe(1);
		expect(bad("RE.exec(`${text}`);")).toBe(1);
		expect(bad("text.replace(/a/g, 'b');")).toBe(1);
	});

	it("deixa passar o que não é texto livre ou não é padrão", () => {
		expect(bad("if (loaded.includes(id)) return;")).toBe(0);
		expect(bad("if (name.startsWith('work:')) return;")).toBe(0);
		expect(bad("if (NONCE.test(value)) return;")).toBe(0);
		expect(bad("text.replace('a', 'b');")).toBe(0); // troca literal, sem RegExp
		expect(bad("const n = text.length; messages.push(m);")).toBe(0);
		expect(bad("x = JSON.stringify(text);")).toBe(0);
	});

	it("aceita validação de formato com o comentário e exige o motivo", () => {
		expect(bad("// guard-allow: format-validation id do cofre\nconst ok = /^[a-z]+$/.test(text);")).toBe(0);
		expect(bad("const ok = /^[a-z]+$/.test(text); // guard-allow: format-validation nonce hex")).toBe(0);
		expect(bad("// guard-allow: format-validation\nconst ok = /^[a-z]+$/.test(text);")).toBe(1);
		expect(bad("// guard-allow: other-reason porque sim\nconst ok = /^[a-z]+$/.test(text);")).toBe(1);
	});

	it("sanitização no estilo escape.ts passa com o comentário e falha sem ele", () => {
		const withComment = [
			"function strip(text: string) {",
			"\t// guard-allow: format-validation remove caractere invisível, não decide nada",
			"\treturn text.replace(/[\\p{Cf}]/gu, '');",
			"}",
		].join("\n");
		expect(bad(withComment)).toBe(0);
		expect(bad(withComment.replace(/\t\/\/ guard-allow.*\n/, ""))).toBe(1);
	});

	it("o relatório traz arquivo e linha", () => {
		const [v] = findViolations("\n\nconst a = message.match(/x/);", "kernel/x.ts");
		expect(v).toMatchObject({ file: "kernel/x.ts", line: 3 });
	});
});
