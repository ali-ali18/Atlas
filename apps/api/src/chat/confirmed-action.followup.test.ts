import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { mcpFollowUpContent } = await import("./confirmed-action.js");
const call = { connectorName: "Tracker", toolName: "link_child", exposedName: "mcp__tracker__link_child" };

test("follow-up de falha manda checar argumentos (ids) antes de concluir que a função não existe", () => {
	const text = mcpFollowUpContent("vincule", call, { ok: false, text: "404 Not Found []", truncated: false });
	assert.match(text, /check whether an argument \(for example an id\) was wrong/);
	assert.doesNotMatch(text, /não repita a mesma chamada sem mudar nada/i);
});

test("follow-up de sucesso não muda", () => {
	const text = mcpFollowUpContent("vincule", call, { ok: true, text: "ok", truncated: false });
	assert.match(text, /Resultado \(Tracker/);
});

test("follow-up da criação de PR manda repetir a chamada com os mesmos argumentos", async () => {
	const { devPrFollowUpContent } = await import("./confirmed-action.js");
	const text = devPrFollowUpContent("confirmado: Criar PR", { title: "Corrige o login", base: "main", head: "fix/login" });
	assert.match(text, /^confirmado: Criar PR/);
	assert.match(text, /APROVOU a criação do pull request "Corrige o login" \(main ← fix\/login\)/);
	assert.match(text, /dev_pr_create de novo com EXATAMENTE os mesmos argumentos/);
});

test("pedido de segredos: o agente recebe só os nomes salvos (nunca valores) e a recusa tem texto próprio", async () => {
	const { secretsFollowUpContent, secretsDeclinedFollowUpContent } = await import("./confirmed-action.js");
	const ok = secretsFollowUpContent("Salvar", { names: ["DATABASE_URL", "STRIPE_KEY"] }, ["DATABASE_URL"]);
	assert.match(ok, /salvou os segredos: DATABASE_URL/);
	assert.match(ok, /Ainda faltam: STRIPE_KEY/);
	assert.match(ok, /nunca os vê/);
	assert.match(secretsFollowUpContent("Salvar", { names: ["A_B"] }, []), /nenhum segredo pedido foi salvo/);
	assert.match(secretsDeclinedFollowUpContent("Agora não", { names: ["A_B"] }), /preferiu não fornecer agora: A_B/);
});
