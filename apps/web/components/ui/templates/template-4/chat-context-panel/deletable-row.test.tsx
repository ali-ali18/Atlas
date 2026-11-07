import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert";
import { DeletableRow } from "./deletable-row";

Object.assign(globalThis, { React });

const noop = () => undefined;
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const row = (props: Partial<React.ComponentProps<typeof DeletableRow>> = {}) => (
	<DeletableRow cancelLabel="Cancelar" confirmBody="A nota some." confirmLabel="Apagar" confirmTitle="Apagar a nota “X”?" deleteLabel="Apagar nota X" onDelete={noop} rowId="n1" {...props}>
		<span>conteúdo</span>
	</DeletableRow>
);

test("apagar pede confirmação na própria linha (estado de saída) com texto destrutivo", () => {
	const out = html(row({ confirming: true }));
	assert.match(out, /Apagar a nota “X”\?/);
	assert.match(out, /A nota some\./);
	assert.match(out, />Apagar</);
	assert.match(out, />Cancelar</);
	assert.doesNotMatch(out, /conteúdo/);
	assert.doesNotMatch(out, /Precisa de você/, "foi o próprio usuário que clicou: nada pendente");
	assert.doesNotMatch(out, /<svg[^>]*aria-label=/, "sem o ícone de alerta do pedido");
});

test("ConfirmAlert: o pedido do bot mantém o selo; a confirmação do próprio usuário (selfConfirm) não tem", () => {
	const asked = html(<ConfirmAlert title="Enviar?" />);
	assert.match(asked, /Precisa de você/);
	const own = html(<ConfirmAlert selfConfirm title="Apagar?" />);
	assert.doesNotMatch(own, /Precisa de você/);
	assert.match(own, /Apagar\?/);
	assert.match(html(<ConfirmAlert selfConfirm status="approved" title="Apagar?" />), /Aprovado/, "decidido, o selo volta");
});

test("a lixeira fica escondida no toque até a pressão longa e só aparece no hover/foco no mouse", () => {
	const button = (markup: string) => markup.match(/<button[^>]*aria-label="Apagar nota X"[^>]*>/)?.[0] ?? "";
	const hidden = button(html(row()));
	assert.ok(hidden, "botão existe");
	assert.match(hidden, /\[@media\(hover:hover\)\]:opacity-0/);
	assert.match(hidden, /group-focus-within\/row:opacity-100/);
	assert.match(hidden, /\[@media\(hover:none\)\]:hidden/, "toque: escondido");
	assert.doesNotMatch(button(html(row({ revealed: true }))), /\[@media\(hover:none\)\]:hidden/, "pressão longa revela");
});

test("canDelete=false tira a lixeira; trailing e rowData ficam na linha", () => {
	const out = html(row({ canDelete: false, trailing: <i data-switch />, rowData: { "data-agenda-card": "a1" } }));
	assert.doesNotMatch(out, /aria-label="Apagar nota X"/);
	assert.match(out, /data-switch/);
	assert.match(out, /data-agenda-card="a1"/);
	assert.match(out, /data-deletable-row="n1"/);
});
