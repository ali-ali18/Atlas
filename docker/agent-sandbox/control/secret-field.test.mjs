import { test, after } from "node:test";
import assert from "node:assert/strict";
import { launchFixtureBrowser } from "./test-browser.mjs";
import { assertNotSecretField, secretKindInPage, TYPING_ACTIONS } from "./secret-field.mjs";

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
const fixture = await launchFixtureBrowser(pages);
after(async () => { await fixture?.close(); });

test("Chromium: senha, current/new-password e one-time-code recusam; campo comum e botão passam", { skip: !fixture }, async () => {
	const page = await fixture.newPage();
	await page.goto(`${fixture.base}/f`);
	for (const id of ["pw", "cur", "new", "otp", "otp2"]) await assert.rejects(assertNotSecretField(page.locator(`#${id}`)), /filled only via login_fill/, id);
	for (const id of ["user", "ta", "btn"]) await assertNotSecretField(page.locator(`#${id}`));
	assert.equal(await page.locator("#pw").evaluate(secretKindInPage), "password");
	assert.equal(await page.locator("#otp").evaluate(secretKindInPage), "code");
	await page.close();
});

test("elemento que não dá para ler = recusa (fail-closed)", async () => {
	await assert.rejects(assertNotSecretField({ evaluate: async () => { throw new Error("detached"); } }), /Could not check/);
});
