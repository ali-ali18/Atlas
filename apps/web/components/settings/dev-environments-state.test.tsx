import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { DevEnvSuggestionView, DevEnvironmentView } from "@/lib/atlas-api";
import { computerHint, connectionsHint } from "./settings-mobile-model";
import { CommandsEditor, DevEnvironmentsListView, SecretsEditor } from "./sections/dev-environments";
import {
	EMPTY_DEV_ENV_FORM,
	approvalOptions,
	showsCommandAllowlist,
	addCommandPrefixes,
	addDomains,
	applySuggestion,
	analyzeSecretsText,
	savedSecretsLabel,
	secretLimitError,
	environmentsHint,
	envSummary,
	formFromEnvironment,
	inputFromForm,
	suggestRepos,
	validateEnvForm,
} from "./dev-environments-state";

Object.assign(globalThis, { React });

const env = (patch: Partial<DevEnvironmentView> = {}): DevEnvironmentView => ({
	id: "e1",
	repo: "acme/site",
	installCommand: "pnpm install",
	startCommand: null,
	testCommand: null,
	tier: "medium",
	network: "allowlist",
	allowlist: ["registro.empresa.com"],
	approvalMode: null,
	commandAllowlist: ["pnpm test", "make build"],
	secrets: [{ name: "API_KEY", set: true }],
	createdAt: "2026-10-18T10:00:00.000Z",
	updatedAt: "2026-10-18T10:00:00.000Z",
	...patch,
});

test("resumo da linha: recursos, internet e segredos", () => {
	assert.equal(envSummary(env()), "Médio · 2,5 GB · Lista liberada · 1 segredo");
	assert.equal(envSummary(env({ tier: "small", network: "off", secrets: [] })), "Pequeno · 1 GB · Sem internet após preparar");
	assert.equal(envSummary(env({ tier: "large", network: "full", secrets: [{ name: "A", set: true }, { name: "B", set: true }] })), "Grande · 4 GB · Acesso total · 2 segredos");
});

test("formulário: converte de e para a API e valida o repositório", () => {
	const form = formFromEnvironment(env());
	assert.equal(form.installCommand, "pnpm install");
	assert.deepEqual(inputFromForm({ ...form, repo: " Acme/Site ", startCommand: "  " }), {
		repo: "acme/site",
		installCommand: "pnpm install",
		startCommand: null,
		testCommand: null,
		tier: "medium",
		network: "allowlist",
		allowlist: ["registro.empresa.com"],
		approvalMode: null,
		commandAllowlist: ["pnpm test", "make build"],
	});
	assert.equal(validateEnvForm({ ...EMPTY_DEV_ENV_FORM, repo: "x" }, [], null).ok, false);
	assert.equal(validateEnvForm({ ...EMPTY_DEV_ENV_FORM, repo: "acme/site" }, [env()], null).ok, false);
	assert.equal(validateEnvForm({ ...EMPTY_DEV_ENV_FORM, repo: "acme/site" }, [env()], "e1").ok, true);
});

test("domínios: aceita vários de uma vez, ignora padrão e repetidos, avisa inválido", () => {
	const result = addDomains(["a.com"], "b.com, *.c.com github.com a.com");
	assert.deepEqual(result.domains, ["a.com", "b.com", "*.c.com"]);
	assert.equal(result.error, null);
	assert.match(addDomains([], "não é domínio").error ?? "", /Domínio inválido/);
});

test("segredos em texto: analisa KEY=value, mostra erros por linha e avisa o que substitui", () => {
	const result = analyzeSecretsText("# banco@@NL@@export DATABASE_URL=\"postgres://u:p@h/db?x=1\"@@NL@@API_KEY=sk-123=abc@@NL@@linha sem igual@@NL@@9RUIM=x@@NL@@API_KEY=ultimo".split("@@NL@@").join(String.fromCharCode(10)), ["API_KEY", "OUTRO"]);
	assert.deepEqual(result.entries, [{ name: "DATABASE_URL", value: "postgres://u:p@h/db?x=1" }, { name: "API_KEY", value: "ultimo" }]);
	assert.deepEqual(result.errors, ["linha 4: falta '='", "linha 5: o nome 9RUIM não pode começar com número"]);
	assert.deepEqual(result.overwrites, ["API_KEY"]);
	assert.equal(analyzeSecretsText("", []).entries.length, 0);
});

test("segredos: limite conta só nomes novos e rótulo de salvos", () => {
	assert.equal(secretLimitError(Array.from({ length: 31 }, (_, i) => "K" + i), []), "No máximo 30 segredos por ambiente");
	assert.equal(secretLimitError(["A"], ["A", "B"]), null);
	assert.equal(savedSecretsLabel(1), "1 segredo salvo");
	assert.equal(savedSecretsLabel(3), "3 segredos salvos");
});

test("preenchimento pelo repositório: só campos não mexidos, nunca sobrescreve o digitado", () => {
	const suggestion: DevEnvSuggestionView = { detected: true, packageManager: "pnpm", installCommand: "pnpm install --frozen-lockfile", startCommand: "pnpm dev", testCommand: "pnpm test", tier: "medium", commandAllowlist: ["pnpm test"], monorepo: true };
	const fresh = applySuggestion(EMPTY_DEV_ENV_FORM, suggestion, new Set());
	assert.equal(fresh.filled, true);
	assert.equal(fresh.form.installCommand, "pnpm install --frozen-lockfile");
	assert.equal(fresh.form.tier, "medium");
	assert.deepEqual(fresh.form.commandAllowlist, ["pnpm test"]);
	const typed = applySuggestion({ ...EMPTY_DEV_ENV_FORM, installCommand: "make setup" }, suggestion, new Set(["tier", "commandAllowlist"]));
	assert.equal(typed.form.installCommand, "make setup");
	assert.equal(typed.form.startCommand, "pnpm dev");
	assert.equal(fresh.form.testCommand, "pnpm test");
	// o teste rápido digitado pelo usuário não é trocado pela sugestão
	assert.equal(applySuggestion({ ...EMPTY_DEV_ENV_FORM, testCommand: "make t" }, suggestion, new Set()).form.testCommand, "make t");
	assert.equal(applySuggestion(EMPTY_DEV_ENV_FORM, suggestion, new Set(["testCommand"])).form.testCommand, "");
	assert.equal(typed.form.tier, "small");
	assert.deepEqual(typed.form.commandAllowlist, EMPTY_DEV_ENV_FORM.commandAllowlist);
	assert.equal(applySuggestion(EMPTY_DEV_ENV_FORM, { ...suggestion, detected: false }, new Set()).filled, false);
});

test("editor de segredos: um textarea, definidos sem valor, aviso de substituição e erros por linha", () => {
	const html = renderToStaticMarkup(
		<SecretsEditor
			available
			busyName={null}
			errors={["linha 3: falta '='"]}
			existing={[{ name: "DATABASE_URL", set: true }]}
			onRemoveExisting={() => undefined}
			onTextChange={() => undefined}
			savedCount={2}
			text={"DATABASE_URL=novo-valor-secreto"}
		/>,
	);
	assert.match(html, /<textarea/);
	assert.match(html, /definido/);
	assert.match(html, /Importar .env/);
	assert.match(html, /linha 3: falta/);
	assert.match(html, /substitui o valor já definido/);
	assert.match(html, /2 segredos salvos/);
	assert.doesNotMatch(html, /type="password"/);
});

test("sugestões de repositório: filtra por texto e esconde os que já têm ambiente", () => {
	const repos = [{ fullName: "Acme/Site" }, { fullName: "Acme/Api" }, { fullName: "outro/app" }];
	assert.deepEqual(suggestRepos(repos, "acme", ["acme/site"]), ["Acme/Api"]);
	assert.deepEqual(suggestRepos(repos, "", []), ["Acme/Site", "Acme/Api", "outro/app"]);
});

test("lista mobile mostra a contagem de ambientes", () => {
	assert.equal(environmentsHint(0), null);
	assert.equal(environmentsHint(2), "2 ambientes de código");
	assert.equal(computerHint(true, 2), "Automático · 2 ambientes");
	assert.equal(computerHint(false, 1), "Manual · 1 ambiente");
	assert.equal(computerHint(undefined, 0), "Navegador e ambientes de código");
	assert.equal(connectionsHint(4), "4 conectados");
});

test("a lista mostra repositório, resumo e nunca valores de segredo", () => {
	const html = renderToStaticMarkup(
		<DevEnvironmentsListView environments={[env()]} error={null} loading={false} onAdd={() => undefined} onEdit={() => undefined} />,
	);
	assert.match(html, /Ambientes de código/);
	assert.match(html, /acme\/site/);
	assert.match(html, /Médio · 2,5 GB · Lista liberada · 1 segredo/);
	assert.match(html, /Editar/);
	assert.match(html, /Adicionar/);
	const empty = renderToStaticMarkup(
		<DevEnvironmentsListView environments={[]} error={null} loading={false} onAdd={() => undefined} onEdit={() => undefined} />,
	);
	assert.match(empty, /Criados automaticamente/);
});

test("aprovação de comandos: modo herdado vai como null, o escolhido vai na API e a lista nasce com os padrões", () => {
	assert.equal(EMPTY_DEV_ENV_FORM.approvalMode, "inherit");
	assert.ok(EMPTY_DEV_ENV_FORM.commandAllowlist.includes("pnpm test"));
	const form = formFromEnvironment(env({ approvalMode: "ask" }));
	assert.equal(form.approvalMode, "ask");
	assert.equal(inputFromForm(form).approvalMode, "ask");
	assert.equal(inputFromForm({ ...form, approvalMode: "inherit" }).approvalMode, null);
	assert.equal(envSummary(env({ approvalMode: "auto" })), "Médio · 2,5 GB · Lista liberada · Comandos: Automático · 1 segredo");
});

test("opções de aprovação: a primeira herda o padrão da conta", () => {
	const options = approvalOptions("auto");
	assert.equal(options[0]!.label, "Padrão da conta (Automático)");
	assert.deepEqual(options.slice(1).map((o) => o.label), ["Perguntar sempre", "Lista liberada", "Automático (recomendado)"]);
	assert.equal(approvalOptions(null)[0]!.label, "Padrão da conta (Automático)");
});

test("lista de comandos: normaliza, não repete e recusa prefixo amplo demais", () => {
	const ok = addCommandPrefixes(["pnpm test"], "make   build, pnpm test");
	assert.deepEqual(ok.list, ["pnpm test", "make build"]);
	assert.equal(ok.error, null);
	const bad = addCommandPrefixes([], "bash");
	assert.deepEqual(bad.list, []);
	assert.match(bad.error ?? "", /inválido/);
});

test("linha da conta: seletor de aprovação no cabeçalho da lista", () => {
	const html = renderToStaticMarkup(<DevEnvironmentsListView defaultApprovalMode="ask" environments={[env()]} error={null} loading={false} onAdd={() => undefined} onChangeDefaultApproval={() => undefined} onEdit={() => undefined} />);
	assert.match(html, /Aprovação de comandos/);
	assert.match(html, /Perguntar sempre/);
});

test("lista de comandos liberados: aparece nos modos Lista liberada e Automático (próprio ou herdado), não em Perguntar sempre, e mostra chips", () => {
	assert.equal(showsCommandAllowlist("allowlist", "ask"), true);
	assert.equal(showsCommandAllowlist("inherit", "allowlist"), true);
	assert.equal(showsCommandAllowlist("inherit", "auto"), true);
	assert.equal(showsCommandAllowlist("auto", "ask"), true);
	assert.equal(showsCommandAllowlist("inherit", "ask"), false);
	assert.equal(showsCommandAllowlist("ask", "allowlist"), false);
	const html = renderToStaticMarkup(<CommandsEditor commands={["pnpm test", "make build"]} onChange={() => undefined} />);
	assert.match(html, /data-slot="dev-env-commands"/);
	assert.match(html, /Remover make build/);
	assert.match(html, /Restaurar os padrões/);
});

test("listas longas viram uma linha compacta com resumo e Editar", async () => {
	const { ListSummaryRow } = await import("./sections/dev-environments");
	const html = renderToStaticMarkup(<ListSummaryRow label="Comandos liberados" onEdit={() => undefined} summary="24" />);
	assert.match(html, /Comandos liberados/);
	assert.match(html, /· 24/);
	assert.match(html, />Editar</);
	assert.doesNotMatch(html, /pnpm test/);
});

test("lista: ambiente automático ganha o selo 'detectado automaticamente'; manual não", () => {
	const html = renderToStaticMarkup(<DevEnvironmentsListView environments={[env({ source: "auto" }), env({ id: "e2", repo: "acme/api", source: "manual" })]} error={null} loading={false} onAdd={() => undefined} onEdit={() => undefined} />);
	assert.equal((html.match(/data-slot="dev-env-auto-tag"/g) ?? []).length, 1);
	assert.match(html, /detectado automaticamente/);
	assert.match(html, /Adicionar manualmente/);
});

test("página cheia do celular: cabeçalho com voltar, conteúdo e ação embaixo com área segura", async () => {
	const { MobilePage } = await import("./sections/dev-environments");
	const html = renderToStaticMarkup(
		<MobilePage footer={<button type="button">Salvar</button>} onBack={() => undefined} title="Novo ambiente">
			<p>conteúdo</p>
		</MobilePage>,
	);
	assert.match(html, /data-slot="dev-env-mobile-page"/);
	assert.match(html, /aria-label="Voltar"/);
	assert.match(html, /Novo ambiente/);
	assert.match(html, /safe-area-inset-bottom/);
	assert.match(html, /overflow-y-auto/);
});

test("linha do Verificador inteligente: rótulo, dica e switch ligado por padrão", () => {
	const common = { environments: [env()], error: null, loading: false, onAdd: () => undefined, onEdit: () => undefined, onChangeDefaultApproval: () => undefined };
	const on = renderToStaticMarkup(<DevEnvironmentsListView {...common} onChangeVerifier={() => undefined} />);
	assert.match(on, /Verificador inteligente/);
	assert.match(on, /um modelo rápido confere se ela combina com o que você pediu/);
	assert.match(on, /aria-checked="true"[^>]*aria-label="Verificador inteligente"/);
	const off = renderToStaticMarkup(<DevEnvironmentsListView {...common} onChangeVerifier={() => undefined} verifierEnabled={false} />);
	assert.match(off, /aria-checked="false"[^>]*aria-label="Verificador inteligente"/);
	const without = renderToStaticMarkup(<DevEnvironmentsListView {...common} />);
	assert.doesNotMatch(without, /Verificador inteligente/);
});

test("segredos: .env do celular (CRLF, export, comentário, aspas, vazios) vira entradas sem erro", () => {
	const CR = String.fromCharCode(13);
	const LF = String.fromCharCode(10);
	const text = ["# producao", "export API_KEY=\"abc 123\"", "db_url='postgres://u:p@h/db'", "VAZIO=", "", "TOKEN=xyz"].join(CR + LF);
	const result = analyzeSecretsText(text, ["TOKEN"]);
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.entries, [
		{ name: "API_KEY", value: "abc 123" },
		{ name: "db_url", value: "postgres://u:p@h/db" },
		{ name: "TOKEN", value: "xyz" },
	]);
	assert.deepEqual(result.overwrites, ["TOKEN"]);
});

test("lista de ambientes mostra a confirmação 'Salvo' e o erro de salvar", () => {
	const html = renderToStaticMarkup(
		<DevEnvironmentsListView environments={[env()]} error={null} loading={false} notice="Salvo" onAdd={() => undefined} onEdit={() => undefined} />,
	);
	assert.match(html, /data-slot="dev-env-notice"/);
	assert.match(html, />Salvo</);
});
