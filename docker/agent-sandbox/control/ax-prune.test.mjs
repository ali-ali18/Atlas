import test from "node:test";
import assert from "node:assert/strict";
import {
	collapseRuns, emittedNodes, footerFor, paginateLines, parseAxYaml, probeTargets, pruneNodes, referencedRefs, renderAx, selectViewport,
} from "./ax-prune.mjs";

const SAMPLE = `- generic [active] [ref=e1] [box=8,8,884,684]:
  - generic [ref=e2] [cursor=pointer] [box=8,8,884,18]: Clique aqui
  - list [ref=e3] [box=8,42,884,36]:
    - listitem [ref=e4] [box=48,42,844,18]:
      - text: um
      - 'link "link \\"aspas\\" e: dois" [ref=e5] [cursor=pointer] [box=72,42,123,17]':
        - /url: /a?x=1&y=2
    - listitem [ref=e6] [box=48,60,844,18]: dois
  - img "foto" [ref=e7] [box=8,96,42,18]
  - generic [ref=e8] [box=50,96,79,17]:
    - checkbox "Lembrar" [checked] [ref=e9] [box=54,97,13,13]
    - text: Lembrar
  - button "Menu" [ref=e10] [box=129,95,49,21]
  - button "Off" [disabled] [ref=e11] [box=178,95,34,21]
  - paragraph [ref=e19] [box=8,178,884,18]:
    - text: Texto
    - emphasis [ref=e20] [box=48,178,36,17]: longo
    - text: com quebra
  - textbox "Senha" [ref=e21] [box=8,212,182,36]: segredo
  - generic [ref=e30] [box=0,0,0,0]
  - img [ref=e31] [box=0,0,5,5]`;

const render = (yaml, opts = {}) => renderAx(pruneNodes(parseAxYaml(yaml).roots), opts).join("\n");

test("parse: nome com aspas escapadas, url, atributos e caixa", () => {
	const { byRef, count } = parseAxYaml(SAMPLE);
	assert.equal(count, 20);
	const link = byRef.get("e5");
	assert.equal(link.name, 'link "aspas" e: dois');
	assert.equal(link.url, "/a?x=1&y=2");
	assert.deepEqual(link.box, [72, 42, 123, 17]);
	assert.equal(link.pointer, true);
	assert.deepEqual(byRef.get("e9").attrs, ["checked"]);
	assert.equal(byRef.get("e6").text, "dois");
});

test("poda: generic some, texto vizinho junta, nome repetido cai, vazio e img sem nome somem", () => {
	const out = render(SAMPLE);
	assert.match(out, /^clickable "Clique aqui" \[e2\]/);
	assert.match(out, /link "link \\"aspas\\" e: dois" \[e5\] \[href=\/a\?x=1&y=2\]/);
	assert.match(out, /checkbox "Lembrar" \[e9\] \[checked\]/);
	assert.doesNotMatch(out, /^ *Lembrar$/m, "o texto igual ao nome do checkbox não repete");
	assert.match(out, /Texto longo com quebra/);
	assert.match(out, /button "Off" \[e11\] \[disabled\]/);
	assert.doesNotMatch(out, /e30|e31/);
	assert.doesNotMatch(out, /generic/);
});

test("valor de campo some por padrão; só sai com a ref aprovada; senha vira aviso", () => {
	const nodes = pruneNodes(parseAxYaml(SAMPLE).roots);
	assert.doesNotMatch(renderAx(nodes).join("\n"), /segredo/);
	assert.match(renderAx(nodes, { values: new Map([["e21", "ok"]]) }).join("\n"), /textbox "Senha" \[e21\]: "segredo"/);
	const secret = renderAx(nodes, { values: new Map([["e21", "secret"]]) }).join("\n");
	assert.doesNotMatch(secret, /segredo/);
	assert.match(secret, /campo de senha: nunca preencha/);
	assert.match(renderAx(nodes, { values: new Map([["e21", "otp"]]) }).join("\n"), /código de uso único/);
});

test("nomes passam de 200 e são cortados", () => {
	const long = "x".repeat(500);
	const out = render(`- button "${long}" [ref=e1] [box=0,0,10,10]`);
	assert.ok(out.length < 230, String(out.length));
	assert.match(out, /…/);
});

const comments = (n, attrs = "") =>
	[`- main [ref=e1] [box=0,0,800,9000]:`]
		.concat(Array.from({ length: n }, (_, i) => `  - article [ref=e${10 + i * 3}] [box=0,${i * 100},800,90]:\n    - paragraph [ref=e${11 + i * 3}]: comentário ${i}\n    - button "Responder" [ref=e${12 + i * 3}] ${attrs}[box=0,${i * 100 + 60},60,20]`))
		.join("\n");

test("irmãos repetidos: mantém 2 e escreve o resto com intervalo e o contêiner", () => {
	const nodes = collapseRuns(pruneNodes(parseAxYaml(comments(40)).roots));
	const lines = renderAx(nodes, { showRefs: referencedRefs(nodes) });
	const text = lines.join("\n");
	assert.equal((text.match(/^ {2}article/gm) ?? []).length, 2);
	assert.match(text, /… \+38 article similares \(e16\.\.e129\) — browser_snapshot ref=e1/);
	assert.ok(text.length < 600, String(text.length));
});

test("poucos irmãos (<5) ficam inteiros; folhas simples só colapsam a partir de 10", () => {
	const few = collapseRuns(pruneNodes(parseAxYaml(comments(4)).roots));
	assert.equal(renderAx(few).join("\n").match(/article/g).length, 4);
	const links = Array.from({ length: 8 }, (_, i) => `  - link "L${i}" [ref=e${i + 2}] [box=0,${i * 20},50,18]`).join("\n");
	const eight = collapseRuns(pruneNodes(parseAxYaml(`- nav [ref=e1] [box=0,0,800,200]:\n${links}`).roots));
	assert.equal(renderAx(eight).join("\n").match(/link "/g).length, 8);
});

test("ref= (expandTop) mostra todos os filhos do contêiner", () => {
	const [main] = pruneNodes(parseAxYaml(comments(40)).roots);
	const expanded = collapseRuns(main.children, { containerRef: main.ref, expandTop: true });
	assert.equal(expanded.filter((n) => n.role === "article").length, 40);
});

test("viewport: só o que cruza a janela, com rodapé do que ficou fora", () => {
	const pruned = pruneNodes(parseAxYaml(comments(40)).roots);
	const sel = selectViewport(pruned, { width: 800, height: 250 });
	const text = renderAx(collapseRuns(sel.nodes)).join("\n");
	assert.match(text, /comentário 0/);
	assert.doesNotMatch(text, /comentário 20/);
	const footer = footerFor(sel.dropped, sel.omitted);
	assert.match(footer[0], /fora da janela/);
	assert.match(footer[1], /\+\d+ article fora da janela em main: browser_snapshot ref=e1/);
});

test("iframe: a caixa dos filhos soma a do iframe em cadeia", () => {
	const yaml = `- main [ref=e1] [box=0,0,900,2000]:
  - iframe [ref=e2] [box=100,300,400,200]:
    - button "dentro" [ref=f1e2] [box=10,20,50,20]
    - iframe [ref=f1e3] [box=0,100,100,50]:
      - button "fundo" [ref=f2e2] [box=5,5,10,10]`;
	const { byRef } = parseAxYaml(yaml);
	assert.deepEqual(byRef.get("f1e2").abs, [110, 320, 50, 20]);
	assert.deepEqual(byRef.get("f2e2").abs, [105, 405, 10, 10]);
	const sel = selectViewport(pruneNodes(parseAxYaml(yaml).roots), { width: 900, height: 400 });
	const text = renderAx(sel.nodes).join("\n");
	assert.match(text, /button "dentro" \[f1e2\]/);
	assert.doesNotMatch(text, /fundo/, "o iframe de dentro passa de 400 px");
});

test("sem caixa (Playwright sem boxes): tudo conta como visível", () => {
	const sel = selectViewport(pruneNodes(parseAxYaml(`- main [ref=e1]:\n  - button "A" [ref=e2]`).roots), { width: 10, height: 10 });
	assert.match(renderAx(sel.nodes).join("\n"), /button "A"/);
});

test("emittedNodes lista só nós reais; paginação corta em fim de linha e continua", () => {
	const nodes = pruneNodes(parseAxYaml(SAMPLE).roots);
	assert.ok(emittedNodes(nodes).every((n) => n.role !== "text"));
	const lines = Array.from({ length: 50 }, (_, i) => `linha numero ${i}`);
	const first = paginateLines(lines, { limit: 100 });
	assert.ok(first.text.length <= 100 && first.nextOffset > 0);
	assert.ok(!first.text.endsWith("\n") && first.text.split("\n").every((l) => /^linha numero \d+$/.test(l)));
	const second = paginateLines(lines, { offset: first.nextOffset, limit: 100 });
	assert.match(second.text, /^linha numero \d+/);
	assert.equal(paginateLines(lines, { limit: 99_999 }).nextOffset, null);
});

test("sonda: alvos são interativos, nomeados, origem do texto e todo campo de valor", () => {
	const targets = probeTargets(pruneNodes(parseAxYaml(SAMPLE).roots));
	assert.ok(targets.fields.has("e21"));
	assert.ok(targets.refs.has("e10") && targets.refs.has("e19"), "texto do parágrafo aponta para o elemento de origem");
	assert.equal(targets.refs.has("e21"), false);
});

test("texto de elemento oculto pela sonda some junto (acordeão fechado)", () => {
	const yaml = `- main [ref=e1]:\n  - generic [ref=e2]:\n    - text: conteúdo do acordeão\n  - button "Abrir" [ref=e3]`;
	const nodes = pruneNodes(parseAxYaml(yaml).roots);
	assert.match(renderAx(nodes).join("\n"), /conteúdo do acordeão/);
	assert.doesNotMatch(renderAx(nodes, { hidden: new Set(["e2"]) }).join("\n"), /acordeão/);
});
