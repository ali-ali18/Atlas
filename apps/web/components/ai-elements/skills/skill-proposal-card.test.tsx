import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillProposalCard, type SkillProposalCardProps } from "./skill-proposal-card";
import {
	formToProposalMarkdown,
	proposalErrorMessage,
	proposalResolvedCaption,
	proposalSummary,
	proposalTitle,
	proposalToForm,
	type SkillProposalData,
} from "./skill-proposal";

Object.assign(globalThis, { React });

const proposal: SkillProposalData = {
	proposalId: "p1",
	action: "create",
	status: "pending",
	name: "relatorio-semanal",
	description: "Monta o relatório da semana",
	tools: ["github", "calendar"],
	body: "# Passos\n\n- junte os dados\n\n<script>alert(1)</script>",
	markdown: "---\nname: relatorio-semanal\n---\n# Passos",
	botId: null,
};

function render(props: Partial<SkillProposalCardProps> = {}) {
	return renderToStaticMarkup(<SkillProposalCard proposal={proposal} {...props} />);
}

test("card pendente: ação, nome, escopo, descrição e os botões", () => {
	const html = render();
	assert.match(html, />Criar habilidade</);
	assert.match(html, /Criar a habilidade &quot;relatorio-semanal&quot; para a sua conta\./);
	assert.match(html, />relatorio-semanal</);
	assert.match(html, />Conta</);
	assert.match(html, />Monta o relatório da semana</);
	assert.match(html, />Aprovar</);
	assert.match(html, />Recusar</);
	assert.doesNotMatch(html, /skill-proposal-resolved/);
	assert.doesNotMatch(render(), />Editar antes</, "sem handler, não mostra Editar antes");
	assert.match(render({ onEditFirst: () => {} }), />Editar antes</);
});

test("o markdown fica recolhido e abre sem HTML cru", () => {
	const closed = render();
	assert.match(closed, /Ver o conteúdo \(Markdown\)/);
	assert.match(closed, /aria-expanded="false"/);
	assert.doesNotMatch(closed, /junte os dados/);
	const open = render({ defaultOpen: true });
	assert.match(open, /<h1[^>]*>Passos<\/h1>/);
	assert.match(open, /junte os dados/);
	assert.doesNotMatch(open, /<script>/);
});

test("edição de skill de um bot: título, frase e selo mudam", () => {
	const edit: SkillProposalData = { ...proposal, action: "edit", botId: "b1", skillId: "s1", expectedRevision: 2 };
	assert.equal(proposalTitle(edit), "Editar habilidade");
	assert.equal(
		proposalSummary(edit, [{ id: "b1", name: "Ana" }]),
		'Atualizar a habilidade "relatorio-semanal" para o bot Ana.',
	);
	const html = render({ proposal: edit, bots: [{ id: "b1", name: "Ana" }], onEditFirst: () => {} });
	assert.match(html, />Editar habilidade</);
	assert.match(html, />Ana</);
	assert.match(html, />Edição</);
	assert.match(html, />Editar antes</);
});

test("exclusão: 'Apagar habilidade', botão destrutivo e sem Editar antes", () => {
	const del: SkillProposalData = { ...proposal, action: "delete", skillId: "s1" };
	const html = render({ proposal: del, onEditFirst: () => {} });
	assert.match(html, />Apagar habilidade</);
	assert.match(html, /Apagar a habilidade &quot;relatorio-semanal&quot; da sua conta\. Não dá para desfazer\./);
	assert.match(html, />Apagar</);
	assert.doesNotMatch(html, />Aprovar</);
	assert.doesNotMatch(html, />Editar antes</, "exclusão não tem editor");
	assert.match(html, /bg-destructive\/10/, "confirmar com estilo destrutivo");
	assert.match(html, />Exclusão</);
	assert.match(html, /Ver o conteúdo atual/);
	assert.doesNotMatch(render(), /bg-destructive\/10 text-destructive hover/, "criar não é destrutivo");
});

test("estado resolvido: sem botões e com a legenda de cada ação", () => {
	const cases: Array<[SkillProposalData["action"], SkillProposalData["status"], string]> = [
		["create", "approved", "Habilidade criada."],
		["edit", "approved", "Habilidade atualizada."],
		["delete", "approved", "Habilidade apagada."],
		["create", "rejected", "Proposta recusada. Nada foi alterado."],
		["delete", "rejected", "Proposta recusada. Nada foi alterado."],
	];
	for (const [action, status, caption] of cases) {
		const html = render({ proposal: { ...proposal, action, status, skillId: "s1" }, onEditFirst: () => {} });
		assert.doesNotMatch(html, />Aprovar</);
		assert.doesNotMatch(html, />Recusar</);
		assert.doesNotMatch(html, />Editar antes</);
		assert.match(html, new RegExp(caption.replace(/\./g, "\.")));
		assert.equal(proposalResolvedCaption({ action, status }), caption);
	}
	assert.equal(proposalResolvedCaption({ action: "create", status: "pending" }), null);
});

test("aplicando trava os botões; erro aparece como alerta", () => {
	const busy = render({ isApplying: true, error: "Já existe uma skill com esse nome." });
	assert.match(busy, />Aplicando…</);
	assert.match(busy, /disabled=""/);
	assert.match(busy, /role="alert"[^>]*>Já existe uma skill com esse nome\./);
});

test("erros do resolve em pt-BR por status (404/409/422/400)", () => {
	const err = (status: number, message = "") => Object.assign(new Error(message), { status });
	assert.match(proposalErrorMessage(err(404)), /não existe mais ou já foi resolvida/);
	assert.match(proposalErrorMessage(err(409)), /mudou ou já existe/);
	assert.match(proposalErrorMessage(err(409, "A skill foi alterada.")), /A skill foi alterada\. Peça ao agente/);
	assert.match(proposalErrorMessage(err(422)), /Limite de habilidades/);
	assert.equal(proposalErrorMessage(err(400, "O nome da skill não pode mudar numa edição.")), "O nome da skill não pode mudar numa edição.");
	assert.match(proposalErrorMessage(new Error("boom")), /Não foi possível aplicar/);
});

test("Editar antes: o editor abre com os campos da proposta e o documento sai em Markdown", () => {
	const form = proposalToForm({ ...proposal, botId: "b1" });
	assert.deepEqual(form, {
		name: "relatorio-semanal",
		description: "Monta o relatório da semana",
		body: proposal.body,
		toolsText: "github, calendar",
		botId: "b1",
	});
	const md = formToProposalMarkdown({ ...form, toolsText: "github , calendar", body: "1. passo" });
	assert.equal(
		md,
		"---\nname: relatorio-semanal\ndescription: Monta o relatório da semana\ntools: [github, calendar]\n---\n\n1. passo\n",
	);
});

test("botões disparam os handlers (aprovar, recusar, editar antes)", () => {
	const calls: string[] = [];
	// O card usa o hook de idioma: chama o componente dentro de um render para ele valer.
	let element!: ReturnType<typeof SkillProposalCard>;
	const Probe = () => {
		element = SkillProposalCard({
			proposal,
			onApprove: () => calls.push("approve"),
			onReject: () => calls.push("reject"),
			onEditFirst: () => calls.push("edit"),
		});
		return null;
	};
	renderToStaticMarkup(<Probe />);
	const props = element.props as {
		onConfirm: () => void;
		onCancel: () => void;
		onEdit: () => void;
		confirmLabel: string;
		cancelLabel: string;
		editLabel: string;
	};
	props.onConfirm();
	props.onCancel();
	props.onEdit();
	assert.deepEqual(calls, ["approve", "reject", "edit"]);
	assert.deepEqual([props.confirmLabel, props.cancelLabel, props.editLabel], ["Aprovar", "Recusar", "Editar antes"]);
});
