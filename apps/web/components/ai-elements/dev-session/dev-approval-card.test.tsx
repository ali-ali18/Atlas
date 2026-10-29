import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DevApprovalCard } from "./dev-approval-card";

Object.assign(globalThis, { React });

const command = { kind: "command" as const, command: "pnpm exec vitest run && docker ps", cwd: "/workspace/site", repo: "octo/site", branch: "fix/login", reason: "Este comando não está na lista liberada.", prefixes: ["pnpm exec vitest", "docker ps"] };

test("comando: mostra o comando inteiro em mono, cwd, repo/branch e as quatro ações", () => {
	const out = renderToStaticMarkup(<DevApprovalCard info={command} onAlways={() => undefined} onConfirm={() => undefined} onReject={() => undefined} onSkip={() => undefined} title="Executar este comando?" />);
	assert.match(out, /data-dev-approval-command[^>]*>.*pnpm exec vitest run &amp;&amp; docker ps/s);
	assert.match(out, /font-mono/);
	assert.match(out, /em \/workspace\/site/);
	assert.match(out, /octo\/site/);
	assert.match(out, /fix\/login/);
	assert.match(out, />Executar</);
	assert.match(out, /data-dev-approval-more/);
	assert.match(out, /aria-label="Mais opções"/);
	assert.doesNotMatch(out, />Pular</, "as demais ações ficam no menu ⋮");
	assert.match(out, /Precisa de aprovação/);
	assert.ok(out.indexOf(">Executar<") < out.indexOf("data-dev-approval-more"), "primária antes do menu");
});

test("bloqueio de segurança mostra o motivo (o menu ⋮ só abre no clique)", () => {
	const none = renderToStaticMarkup(<DevApprovalCard info={{ ...command, prefixes: undefined, reason: "Bloqueio de segurança: force push." }} onAlways={() => undefined} title="Executar este comando?" />);
	assert.doesNotMatch(none, /Sempre permitir/);
	assert.match(none, /Bloqueio de segurança/);
});

test("escrita de arquivo: caminho, prévia do diff e Aplicar/Pular", () => {
	const out = renderToStaticMarkup(
		<DevApprovalCard
			confirmLabel="Aplicar"
			info={{ kind: "write", path: "src/a.ts", preview: "-velho\n+novo", added: 1, removed: 1, repo: "octo/site", branch: "main" }}
			onConfirm={() => undefined}
			onSkip={() => undefined}
			title="Aplicar esta alteração?"
		/>,
	);
	assert.match(out, /data-dev-approval-path[^>]*>.*src\/a\.ts/s);
	assert.match(out, /data-dev-approval-diff/);
	assert.match(out, />-velho</);
	assert.match(out, />\+novo</);
	assert.match(out, />Aplicar</);
	assert.doesNotMatch(out, /Sempre permitir/);
});

test("decidido: só o selo, sem barra de ações", () => {
	const out = renderToStaticMarkup(<DevApprovalCard info={command} status="approved" title="Executar este comando?" />);
	assert.match(out, /Aprovado/);
	assert.doesNotMatch(out, /chat-card-actions/);
	const skipped = renderToStaticMarkup(<DevApprovalCard info={command} status="rejected" title="Executar este comando?" />);
	assert.match(skipped, /Recusado/);
});

test("opções do menu: Permitir uma vez, Sempre neste repositório (com o que libera) e Pular", async () => {
	const { devApprovalOptions } = await import("@/lib/dev-approval-options");
	const options = devApprovalOptions({ prefixes: ["git push", "docker ps"], canAlways: true });
	assert.deepEqual(
		options.map((option) => option.label),
		["Permitir uma vez", "Sempre neste repositório", "Pular"],
	);
	assert.equal(options[1]!.detail, "Libera: git push, docker ps");
	assert.deepEqual(devApprovalOptions({ prefixes: [], canAlways: true }).map((option) => option.id), ["skip"]);
	assert.deepEqual(devApprovalOptions({ prefixes: ["make build"], canAlways: false }).map((option) => option.id), ["skip"]);
});

test("cartão de comando com prefixos monta o menu ⋮ com a opção de sempre; sem prefixos não (nada de Atlas)", () => {
	const withAlways = renderToStaticMarkup(<DevApprovalCard info={command} onAlways={() => undefined} onConfirm={() => undefined} onSkip={() => undefined} title="Executar este comando?" />);
	assert.match(withAlways, /data-dev-approval-more/);
	assert.doesNotMatch(withAlways, /Atlas/i);
	const bare = renderToStaticMarkup(<DevApprovalCard info={{ ...command, prefixes: [] }} onAlways={() => undefined} title="Executar este comando?" />);
	assert.match(bare, /data-dev-approval-more/, "o menu ⋮ segue com Pular");
});
