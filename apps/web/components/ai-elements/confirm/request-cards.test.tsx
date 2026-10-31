import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestCard } from "@workspace/ui/components/request-card";
import { ConfirmCard } from "./confirm-card";
import { LoginCard } from "../login/login-card";
import { QuestionnaireCard, type QuestionnaireCardMessage } from "@/components/ui/templates/template-4/chat-thread/questionnaire-card";

Object.assign(globalThis, { React });

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

test("casca: cabeçalho com selo, ações com a primária primeiro e terciária à direita", () => {
	const out = html(
		<RequestCard
			actions={<button type="button">Permitir uma vez</button>}
			badge={{ tone: "pending", label: "Precisa de você" }}
			description="Rodar um comando"
			leading={<span>i</span>}
			title="Aprovar comando"
			trailing={<button type="button">Negar</button>}
		/>,
	);
	assert.match(out, /data-slot="request-card"[^>]*data-state="pending"/);
	assert.match(out, /data-tone="pending"[^>]*>Precisa de você</);
	assert.ok(out.indexOf("Permitir uma vez") < out.indexOf("Negar"), "primária antes da terciária");
	assert.match(out, /ml-auto/);
});

test("casca resolvida: sem barra de ações e corpo recolhido atrás do detalhe", () => {
	const out = html(
		<RequestCard
			actions={<button type="button">Aprovar</button>}
			badge={{ tone: "success", label: "Aprovado" }}
			detailsLabel="Ver as mudanças"
			resolved
			title="Mudar nome"
		>
			<p>antes e depois</p>
		</RequestCard>,
	);
	assert.match(out, /data-state="resolved"/);
	assert.doesNotMatch(out, /chat-card-actions|>Aprovar</);
	assert.match(out, />Ver as mudanças</);
	assert.doesNotMatch(out, /antes e depois/);
});

test("confirmação pendente: confirmar antes de recusar; decidida só mostra o selo", () => {
	const pending = html(<ConfirmCard title="Enviar e-mail?" confirmLabel="Enviar" cancelLabel="Cancelar" onAlways={() => {}} alwaysLabel="Sempre" />);
	assert.match(pending, /Precisa de você/);
	assert.ok(pending.indexOf(">Enviar<") < pending.indexOf(">Sempre<"));
	assert.ok(pending.indexOf(">Sempre<") < pending.indexOf(">Cancelar<"));
	const done = html(<ConfirmCard title="Enviar e-mail?" status="approved" />);
	assert.match(done, />Aprovado</);
	assert.doesNotMatch(done, /<button/);
});

test("login/captcha: Abrir a VM primeiro, Terminei depois; concluído sem botões", () => {
	const pending = html(<LoginCard site="exemplo.com" />);
	assert.match(pending, /Preciso que você faça login em exemplo\.com/);
	assert.ok(pending.indexOf(">Abrir a VM<") < pending.indexOf(">Terminei<"));
	assert.match(html(<LoginCard site="exemplo.com" reason="captcha" />), /pediu uma verificação/);
	const done = html(<LoginCard site="exemplo.com" status="done" />);
	assert.match(done, />Concluído</);
	assert.doesNotMatch(done, /<button/);
});

test("login com Cofre: Entrar primeiro, Eu faço depois; sem 'Abrir a VM' nem atalho de salvar", () => {
	const vault = { name: "chatgpt", label: "ChatGPT", username: "ana@exemplo.com", domain: "chatgpt.com" };
	const pending = html(<LoginCard site="chatgpt.com" vault={vault} onSaveToVault={() => {}} />);
	assert.match(pending, /Entrar em chatgpt.com com o login do Cofre (ana@exemplo.com)?/);
	assert.ok(pending.indexOf(">Entrar<") < pending.indexOf(">Eu faço<"));
	assert.doesNotMatch(pending, /Abrir a VM|login-save-to-vault/);
	assert.doesNotMatch(pending, /senha[^<]*ana@/);
});

test("login sem Cofre: atalho para salvar um login; com passo extra explica o que falta e não oferece salvar", () => {
	const plain = html(<LoginCard site="chatgpt.com" onSaveToVault={() => {}} />);
	assert.match(plain, /Preciso que você faça login em chatgpt.com/);
	assert.match(plain, /Salvar um login no Cofre para a próxima vez/);
	assert.doesNotMatch(html(<LoginCard site="chatgpt.com" reason="captcha" onSaveToVault={() => {}} />), /Salvar um login/);
	const tried = html(<LoginCard site="chatgpt.com" vaultTried="Usei o login do Cofre, mas o site pediu mais um passo." onSaveToVault={() => {}} />);
	assert.match(tried, /Usei o login do Cofre, mas o site pediu mais um passo./);
	assert.ok(tried.indexOf(">Abrir a VM<") < tried.indexOf(">Terminei<"));
	assert.doesNotMatch(tried, /Salvar um login/);
});

test("login: com e-mail conectado o cartão do cofre avisa; campo de código no cartão humano", () => {
	const vault = { name: "chatgpt", label: "ChatGPT", username: "ana@exemplo.com", domain: "chatgpt.com", emailCode: "Gmail" };
	const offer = html(<LoginCard site="chatgpt.com" vault={vault} />);
	assert.ok(offer.includes("buscar o código no seu e-mail (Gmail)"));
	const field = html(<LoginCard site="chatgpt.com" codeField onSubmitCode={() => {}} vaultTried="Digite o código que chegou no seu e-mail." />);
	assert.match(field, /data-slot="login-code-input"/);
	assert.match(field, /autoComplete="one-time-code"|autocomplete="one-time-code"/);
	assert.ok(field.indexOf(">Enviar código<") < field.indexOf(">Abrir a VM<"));
	assert.doesNotMatch(html(<LoginCard site="chatgpt.com" />), /login-code-input/);
	assert.doesNotMatch(html(<LoginCard site="chatgpt.com" codeField status="done" />), /login-code-input/);
});

test("login do Cofre usado pelo runtime: só uma linha discreta, sem cartão nem botões", () => {
	const vault = { name: "painel-kodea", label: "Painel - Kodea", domain: "kodea.com.br" };
	const out = html(<LoginCard site="panel.kodea.com.br" status="done" vault={vault} />);
	assert.match(out, /data-testid="vault-login-used"/);
	assert.match(out, /Entrei em panel\.kodea\.com\.br com o login do Cofre Painel - Kodea/);
	assert.doesNotMatch(out, /data-slot="request-card"|<button/);
	assert.doesNotMatch(out, /Retomando de onde parou/);
});

test("questionário: pendente tem selo e dispensar; respondido recolhe as respostas", () => {
	const base = {
		id: "q",
		kind: "questionnaire",
		questionnaireId: "q1",
		title: "Preferências",
		items: [{ name: "a", prompt: "Qual?", choices: [{ value: "x", label: "Opção X" }] }],
	} as unknown as QuestionnaireCardMessage;
	const pending = html(<QuestionnaireCard message={base} onDismiss={() => {}} />);
	assert.match(pending, /Precisa de você/);
	assert.match(pending, /Dispensar questionário/);
	const answered = html(<QuestionnaireCard message={{ ...base, status: "submitted", answers: { a: "x" } }} />);
	assert.match(answered, />Respondido</);
	assert.match(answered, />Ver respostas</);
	assert.doesNotMatch(answered, /Opção X/);
});

test("ação primária dos cards usa a cor de destaque do bot (var --bot-accent)", () => {
	const confirm = html(<ConfirmCard title="Aprovar" confirmLabel="Confirmar" onConfirm={() => {}} onCancel={() => {}} />);
	assert.match(confirm, /class="[^"]*bg-\(--bot-accent,var\(--primary\)\)[^"]*"[^>]*>Confirmar/);
	const destructive = html(<ConfirmCard title="Apagar" destructive confirmLabel="Apagar" onConfirm={() => {}} onCancel={() => {}} />);
	assert.doesNotMatch(destructive, /--bot-accent/);
	const login = html(<LoginCard site="exemplo.com" onDone={() => {}} onOpenViewer={() => {}} />);
	assert.match(login, /--bot-accent[^>]*>Abrir a VM/);
});

test("cartão do GitHub: repositório fora do app oferece só instalar o app e Pronto (nunca a conta do usuário)", async () => {
	const { GithubIdentityCard } = await import("./github-identity-card");
	const out = html(<GithubIdentityCard info={{ reason: "not_installed", repo: "exemplo/loja-monorepo", installUrl: "/v1/github-app/install", appName: "meu-app" }} />);
	assert.match(out, /O app não está neste repositório/);
	assert.match(out, /exemplo\/loja-monorepo/);
	assert.match(out, /meu-app\[bot\]/);
	assert.match(out, /href="\/v1\/github-app\/install"[^>]*>Instalar o app neste repositório/);
	assert.match(out, /Pronto, já instalei/);
	assert.doesNotMatch(out, /minha conta|sua conta/i);
	assert.match(out, /Cancelar/);
	const external = html(<GithubIdentityCard info={{ reason: "not_installed", repo: "a/b", installUrl: "https://github.com/settings/installations/9", appName: null }} />);
	assert.match(external, /target="_blank"/);
});

test("cartão do GitHub: depois de decidido some o link de instalação", async () => {
	const { GithubIdentityCard } = await import("./github-identity-card");
	const out = html(<GithubIdentityCard info={{ reason: "not_installed", repo: "a/b", installUrl: "/v1/github-app/install", appName: null }} status="approved" />);
	assert.doesNotMatch(out, /github-install-link/);
});
