import { test, after } from "node:test";
import assert from "node:assert/strict";
import { launchFixtureBrowser } from "./test-browser.mjs";
import { assertNotSecretField, secretKindInPage, TYPING_ACTIONS } from "./secret-field.mjs";
import { createRefActions } from "./browser-refs.mjs";

test("ações que digitam: type, select e press (clear/click/hover não escrevem texto do modelo)", () => {
	assert.deepEqual([...TYPING_ACTIONS].sort(), ["press", "select", "type"]);
});

const pages = {
	"/f": `<title>f</title>
<input id="pw" type="password" aria-label="x [a999]">
<input id="cur" type="text" autocomplete="current-password">
<input id="new" type="text" autocomplete="new-password">
<input id="otp" type="text" autocomplete="one-time-code">
<input id="otp2" type="text" autocomplete="username one-time-code">
<input id="user" type="text" autocomplete="username">
<textarea id="ta"></textarea>
<button id="btn">ok</button>`,
};
Object.assign(pages, {
	// (1) rótulo (interativo para ter ref) apontando para a senha; e um span dentro de label que envolve a senha
	"/label": `<title>l</title><label for="pw" role="textbox" tabindex="0" id="lab">Senha</label><input id="pw" type="password">
<label id="wrap"><span role="textbox" tabindex="0" id="inner">Senha 2</span><input id="pw2" type="password"></label><input id="user" type="text" aria-label="Usuário">`,
	// (2) usuário e senha; alvos que não recebem foco; o contador de teclas da senha prova que nada chegou
	"/focus": `<title>f</title><input id="user" type="text" aria-label="Usuário"><input id="pw" type="password" aria-label="Senha">
<span role="button" id="nofocus" onclick="void 0">Texto solto</span><div role="textbox" id="tb" tabindex="0" aria-label="Caixa">c</div>
<script>window.keys=0;document.getElementById('pw').addEventListener('keydown',()=>window.keys++);</script>`,
	// (3) vira senha na primeira digitação
	"/flip": `<title>x</title><input id="f" type="text" aria-label="Campo"><script>
document.getElementById('f').addEventListener('input',e=>{e.target.type='password'});</script>`,
	// (3b) vira senha entre o preenchimento e o Enter do submit
	"/flip-submit": `<title>x</title><input id="g" type="text" aria-label="Campo"><script>
window.enters=0;const g=document.getElementById('g');g.addEventListener('input',()=>setTimeout(()=>{g.type='password'},0));g.addEventListener('keydown',e=>{if(e.key==='Enter')window.enters++});</script>`,
	// shadow DOM: a senha dentro de um componente
	"/shadow": `<title>s</title><div id="host"></div><span role="button" id="nofocus" onclick="void 0">Texto</span><script>
const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<input id="spw" type="password" aria-label="Senha shadow">';</script>`,
});
const fixture = await launchFixtureBrowser(pages);
after(async () => { await fixture?.close(); });

test("Chromium: senha, current/new-password e one-time-code recusam; campo comum e botão passam", { skip: !fixture }, async () => {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}/f`);
	for (const id of ["pw", "cur", "new", "otp", "otp2"]) await assert.rejects(assertNotSecretField(page.locator(`#${id}`)), /filled only via login_fill/, id);
	for (const id of ["user", "ta"]) await assertNotSecretField(page.locator(`#${id}`));
	// Botão não é campo: ação que digita é recusada (o alvo efetivo precisa aceitar texto).
	await assert.rejects(assertNotSecretField(page.locator("#btn")), /not a field that accepts typing/);
	assert.equal(await page.locator("#pw").evaluate(secretKindInPage), "password");
	assert.equal(await page.locator("#otp").evaluate(secretKindInPage), "code");
	await page.close();
});

test("elemento que não dá para ler = recusa (fail-closed)", async () => {
	await assert.rejects(assertNotSecretField({ evaluate: async () => { throw new Error("detached"); } }), /Could not check/);
});

// --- Integração com Chromium REAL: o `browserAct` inteiro (ref do snapshot → barreira → Playwright) ---
async function open(path) {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}${path}`);
	const actions = createRefActions({ withPageRetry: async (fn) => fn(page), sleep: async () => {} });
	const snapshot = await actions.browserSnapshot({ engine: "dom", area: "page" });
	const refOf = (name) => {
		const line = snapshot.lines.find((item) => item.includes(`"${name}"`));
		const ref = line && /\[(e\d+)\]/.exec(line)?.[1];
		if (!ref) throw new Error(`sem ref para ${name}: ${snapshot.lines.join(" | ")}`);
		return ref;
	};
	return { page, actions, refOf };
}
const value = (page, id) => page.locator(`#${id}`).inputValue();

test("Chromium: label for=senha com fill/type/select é recusado e a senha fica vazia", { skip: !fixture }, async () => {
	const { page, actions, refOf } = await open("/label");
	const label = refOf("Senha");
	for (const action of ["type"]) {
		await assert.rejects(actions.browserAct({ ref: label, action, value: "inventada" }), /filled only via login_fill/);
		await assert.rejects(actions.browserAct({ ref: label, action, value: "inventada", sequential: true }), /filled only via login_fill/);
	}
	assert.equal(await value(page, "pw"), "");
	// Descendente de label que envolve a senha: o alvo efetivo é o controle da label.
	await assert.rejects(actions.browserAct({ ref: refOf("Senha 2"), action: "type", value: "inventada" }), /filled only via login_fill|not accept typing/);
	assert.equal(await value(page, "pw2"), "");
	await actions.browserAct({ ref: refOf("Usuário"), action: "type", value: "joao" });
	assert.equal(await value(page, "user"), "joao");
	await page.close();
});

test("Chromium: clique na senha + press em alvo sem foco é recusado e nenhuma tecla chega à senha", { skip: !fixture }, async () => {
	const { page, actions, refOf } = await open("/focus");
	await actions.browserAct({ ref: refOf("Senha"), action: "click" });
	await assert.rejects(actions.browserAct({ ref: refOf("Texto solto"), action: "press", value: "a" }), /did not receive keyboard focus|takes keyboard input|filled only via login_fill/);
	assert.equal(await page.evaluate(() => window.keys), 0);
	assert.equal(await value(page, "pw"), "");
	// Alvo focalizável de entrada, mesmo com a senha com foco, é permitido: o foco vai para ele.
	await actions.browserAct({ ref: refOf("Caixa"), action: "press", value: "a" });
	assert.equal(await page.evaluate(() => window.keys), 0);
	await page.close();
});

test("Chromium: Tab do usuário para a senha e depois press em alvo sem foco é recusado", { skip: !fixture }, async () => {
	const { page, actions, refOf } = await open("/focus");
	await actions.browserAct({ ref: refOf("Usuário"), action: "press", value: "Tab" });
	assert.equal(await page.evaluate(() => document.activeElement?.id), "pw");
	await assert.rejects(actions.browserAct({ ref: refOf("Texto solto"), action: "press", value: "x" }), /filled only via login_fill|did not receive keyboard focus/);
	assert.equal(await page.evaluate(() => window.keys), 0);
	assert.equal(await value(page, "pw"), "");
	await page.close();
});

test("Chromium: foco dentro de shadow DOM numa senha também conta", { skip: !fixture }, async () => {
	const { page, actions, refOf } = await open("/shadow");
	await page.evaluate(() => document.getElementById("host").shadowRoot.getElementById("spw").focus());
	await assert.rejects(actions.browserAct({ ref: refOf("Texto"), action: "press", value: "x" }), /filled only via login_fill|did not receive keyboard focus/);
	await page.close();
});

test("Chromium: campo que vira senha durante a digitação é recusado e o valor é apagado", { skip: !fixture }, async () => {
	const { page, actions, refOf } = await open("/flip");
	await assert.rejects(actions.browserAct({ ref: refOf("Campo"), action: "type", value: "segredo123" }), /became a password.*cleared/);
	assert.equal(await value(page, "f"), "");
	await page.close();
});

test("Chromium: campo que vira senha antes do Enter do submit: a tecla não é enviada e o valor é apagado", { skip: !fixture }, async () => {
	const { page, actions, refOf } = await open("/flip-submit");
	await assert.rejects(actions.browserAct({ ref: refOf("Campo"), action: "type", value: "segredo123", submit: true }), /filled only via login_fill|became a password/);
	assert.equal(await page.evaluate(() => window.enters), 0);
	assert.equal(await value(page, "g"), "");
	await page.close();
});
