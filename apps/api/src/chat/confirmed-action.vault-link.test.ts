import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
const { applyVaultUseApproval, vaultUseFollowUpContent } = await import("./confirmed-action.js");
const { VaultService, memoryVaultStore } = await import("@workspace/agent-runtime");

async function seed() {
	const vault = new VaultService(memoryVaultStore());
	const a = await vault.create("user-a", { kind: "login", name: "painel-kodea", label: "Painel - Kodea", username: "dono@x.com", payload: { password: "Senha!123" } });
	return { vault, a };
}

test('"Sim" no cartão de vínculo grava o hostname exato no item do dono', async () => {
	const { vault, a } = await seed();
	const ok = await applyVaultUseApproval(vault, "user-a", { secretId: a.id, linkHost: "panel.kodea.com.br" }, { botId: "b1", conversationId: "c1" });
	assert.equal(ok, true);
	const item = (await vault.listMeta("user-a")).find((i) => i.id === a.id)!;
	assert.equal(item.siteUrl, "https://panel.kodea.com.br");
	assert.equal(item.domain, "panel.kodea.com.br");
});

test("outro usuário não vincula nem enxerga o item (IDOR); nada muda", async () => {
	const { vault, a } = await seed();
	assert.equal(await applyVaultUseApproval(vault, "user-b", { secretId: a.id, linkHost: "evil.example" }, {}), false);
	assert.equal((await vault.listMeta("user-a")).find((i) => i.id === a.id)!.siteUrl ?? "", "");
	assert.deepEqual(await vault.listMeta("user-b"), []);
});

test("host inválido ou com caminho não é gravado; site já salvo não é sobrescrito", async () => {
	const { vault, a } = await seed();
	for (const linkHost of ["evil.example/login", "https://evil.example", "user@evil.example", ""]) {
		assert.equal(await applyVaultUseApproval(vault, "user-a", { secretId: a.id, linkHost: linkHost || undefined }, {}) && Boolean(linkHost), false, linkHost);
	}
	assert.equal((await vault.listMeta("user-a")).find((i) => i.id === a.id)!.siteUrl ?? "", "");
	await applyVaultUseApproval(vault, "user-a", { secretId: a.id, linkHost: "panel.kodea.com.br" }, {});
	await applyVaultUseApproval(vault, "user-a", { secretId: a.id, linkHost: "outro.example" }, {});
	assert.equal((await vault.listMeta("user-a")).find((i) => i.id === a.id)!.siteUrl, "https://panel.kodea.com.br");
});

test("a mensagem de retorno ao agente diz que o site ficou salvo e nunca traz a senha", () => {
	const text = vaultUseFollowUpContent("", { label: "Painel - Kodea", domain: "panel.kodea.com.br", linkHost: "panel.kodea.com.br" }, "approved");
	assert.match(text, /site ficou salvo/);
	assert.match(text, /login_fill/);
	assert.doesNotMatch(text, /Senha!123/);
});
