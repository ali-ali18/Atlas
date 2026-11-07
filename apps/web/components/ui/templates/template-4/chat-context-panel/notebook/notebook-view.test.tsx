import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";
import { change, note, NOW, report, rule } from "./fixtures";
import { ReportCard, type ReportCardProps, ReportsList } from "./night-review-view";
import { NotebookSection } from "./notebook-section";
import { NoteForm, NotesList, type NotesListProps } from "./notes-view";
import { RulesList, type RulesListProps } from "./rules-view";

Object.assign(globalThis, { React });

const noop = () => undefined;
const html = (node: React.ReactNode) => renderToStaticMarkup(node);
/** Só o que a pessoa lê: sem marcação e sem atributos. */
const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, " ");

const notesProps = (patch: Partial<NotesListProps> = {}): NotesListProps => ({
	notes: [],
	botId: "b1",
	now: NOW,
	filter: "bot",
	creating: false,
	editingId: null,
	busyId: null,
	formBusy: false,
	formError: null,
	actionError: null,
	limit: 500,
	onFilter: noop,
	onStartCreate: noop,
	onStartEdit: noop,
	onCancelForm: noop,
	onCreate: noop,
	onEdit: noop,
	onPin: noop,
	onDelete: noop,
	...patch,
});

test("seção Caderno: sem o sinal do v4 não desenha nada (nem o título)", () => {
	assert.equal(html(<NotebookSection botId="b1" enabled={false} />), "");
	assert.equal(html(<NotebookSection botId="b1" />), "", "sem resposta do servidor, desligado");
	const on = html(<NotebookSection botId="b1" enabled />);
	assert.match(on, /data-library-section="notebook"/);
	assert.match(on, />Caderno</);
});

test("notas: vazio convida a pedir ao bot; filtro mostra qual está ativo", () => {
	const out = html(<NotesList {...notesProps()} />);
	assert.match(out, /Ainda não há notas/);
	assert.match(out, /aria-pressed="true"[^>]*>Deste bot</);
	assert.match(out, /aria-pressed="false"[^>]*>Todas</);
	assert.match(out, />Nova nota</);
	assert.doesNotMatch(out, /Nova nota<\/button>[\s\S]*Ainda não há notas[\s\S]*Salvar/);
});

test("notas: fixadas primeiro, origem em frase, fixar/editar/apagar com rótulo e lixeira só no hover", () => {
	const out = html(
		<NotesList
			{...notesProps({
				notes: [note({ id: "a", title: "Comum", updatedAt: "2026-11-07T14:00:00Z" }), note({ id: "p", title: "Fixa", pinned: true, source: "sleep", botId: "b1", updatedAt: "2026-11-01T14:00:00Z" })],
			})}
		/>,
	);
	assert.ok(out.indexOf("Fixa") < out.indexOf("Comum"), "fixada vem antes");
	assert.match(out, /Aprendido à noite · Só deste bot/);
	assert.match(out, /Você · Vale para todos os bots · há 1 h/);
	assert.match(out, /aria-label="Desafixar nota Fixa"/);
	assert.match(out, /aria-label="Fixar nota Comum"/);
	assert.match(out, /aria-label="Editar nota Comum"/);
	assert.match(out, /aria-label="Apagar nota Comum"/);
	assert.match(out, /\[@media\(hover:hover\)\]:opacity-0/, "apagar só no hover/foco");
	assert.match(out, /\[@media\(hover:none\)\]:hidden/, "no toque, só depois da pressão longa");
});

test("notas: criar abre o formulário com o escopo; erro do servidor aparece em frase", () => {
	const out = html(<NotesList {...notesProps({ creating: true, formError: "Já existe uma nota com esse mesmo texto." })} />);
	assert.match(out, /data-notebook-note-form/);
	assert.match(out, /Só para este bot/);
	assert.match(out, /Já existe uma nota com esse mesmo texto\./);
	assert.doesNotMatch(out, />Nova nota</, "o botão some enquanto o formulário está aberto");
	assert.match(html(<NoteForm busy error={null} onCancel={noop} onSubmit={noop} />), /Salvando…/);
	assert.doesNotMatch(html(<NoteForm busy={false} error={null} initial={{ title: "a", body: "b" }} onCancel={noop} onSubmit={noop} />), /Só para este bot/, "o escopo não muda ao editar");
});

test("notas: nota longa recolhe atrás de 'Ver detalhes'; perto do teto mostra a contagem do limite", () => {
	const out = html(<NotesList {...notesProps({ notes: [note({ body: "linha ".repeat(60) })], limit: 1 })} />);
	assert.match(out, /Ver detalhes/);
	assert.match(out, /1 de 1 notas/);
	assert.match(html(<NotesList {...notesProps({ notes: [note()] })} />), /1 nota</);
});

const rulesProps = (patch: Partial<RulesListProps> = {}): RulesListProps => ({
	rules: [],
	now: NOW,
	editingId: null,
	busyId: null,
	formBusy: false,
	formError: null,
	actionError: null,
	onStartEdit: noop,
	onCancelEdit: noop,
	onSave: noop,
	onDelete: noop,
	...patch,
});

test("regras: vazio explica como nascem; lista mostra o que vale, quando e a origem", () => {
	assert.match(html(<RulesList {...rulesProps()} />), /Nada aprendido ainda/);
	const out = html(
		<RulesList
			{...rulesProps({
				rules: [rule(), rule({ id: "rule_2", effect: "money", verdict: "deny", source: "owner", learnedAt: null, note: "Só com minha ordem" }), rule({ id: "rule_3", effect: "read", verdict: "run", match: "drive_list_files" })],
			})}
		/>,
	);
	assert.match(out, /Quando o bot for enviar mensagens/);
	assert.match(out, /data-rule-verdict="approve"[^>]*>Sempre perguntar</);
	assert.match(out, /data-rule-verdict="deny"[^>]*>Nunca</);
	assert.match(out, /data-rule-verdict="run"[^>]*>Pode fazer</);
	assert.match(out, /Só com minha ordem/);
	assert.match(out, /Você definiu/);
	assert.match(out, /O bot aprendeu · há 3 dias/);
	assert.match(out, /Só para: listar arquivos do Drive/);
	assert.match(out, /aria-label="Editar regra: gastar dinheiro"/);
	assert.match(out, /aria-label="Apagar regra: gastar dinheiro"/);
	assert.doesNotMatch(visibleText(out), /rule_\d|drive_list_files|drive list files|\bsend\b/, "ids e nomes internos não aparecem");
});

test("regras: editar mostra as três decisões e a observação; erro 422 em frase", () => {
	const out = html(<RulesList {...rulesProps({ rules: [rule()], editingId: "rule_1", formError: "O bot já tem regras demais. Apague algumas antes de mudar." })} />);
	assert.match(out, /data-notebook-rule-form/);
	for (const label of ["Pode fazer", "Sempre perguntar", "Nunca", "Observação \\(opcional\\)"]) assert.match(out, new RegExp(label));
	assert.match(out, /regras demais/);
});

const reportProps = (patch: Partial<ReportCardProps> = {}): ReportCardProps => ({
	report: report(),
	open: true,
	onOpenChange: noop,
	changes: { status: "ready", changes: [change(), change({ id: "c2", target: "note", afterNote: { title: "Roteiro de Lisboa", pinned: false }, after: "texto" }), change({ id: "c3", undoneAt: "2026-11-07T04:00:00Z" })] },
	busyId: null,
	error: null,
	onUndo: noop,
	onDismiss: noop,
	onRetryChanges: noop,
	...patch,
});

test("revisão da noite: resumo, o que mudou com desfazer, e proposta com 'Agora não'", () => {
	const out = html(<ReportsList hasMore loadingMore={false} onLoadMore={noop}><ReportCard {...reportProps()} /></ReportsList>);
	assert.match(out, /Revisão de 6 de nov\./);
	assert.match(out, /Guardei 1 fato e 1 nota/);
	assert.match(out, /1 para você olhar/);
	assert.match(out, /Guardou: Prefere café sem açúcar/);
	assert.match(out, /Guardou a nota “Roteiro de Lisboa”/);
	assert.match(out, /aria-label="Desfazer: Guardou: Prefere café sem açúcar"/);
	assert.match(out, />Desfeito</, "o que já foi desfeito só mostra o estado");
	assert.equal((out.match(/>Desfazer</g) ?? []).length, 2, "o desfeito não oferece desfazer de novo");
	assert.match(out, /Conferir planilha de vendas/);
	assert.match(out, />Habilidade</);
	assert.match(out, /Agora não/);
	assert.match(out, /Ver relatórios mais antigos/);
});

test("revisão da noite: proposta dispensada mostra 'Dispensado' e sai o botão; carregando e erro das mudanças", () => {
	const dismissed = report({ proposals: [{ ...report().proposals[0]!, status: "dismissed" }] });
	const out = html(<ReportCard {...reportProps({ report: dismissed })} />);
	assert.match(out, />Dispensado</);
	assert.doesNotMatch(out, /Agora não/);
	assert.doesNotMatch(out, /para você olhar</, "sem pendência, sem selo de pendência");
	assert.match(html(<ReportCard {...reportProps({ changes: { status: "loading" } })} />), /data-testid="notebook-loading"/);
	assert.match(html(<ReportCard {...reportProps({ changes: { status: "error" } })} />), /Tentar de novo/);
	assert.match(html(<ReportCard {...reportProps({ error: "Não deu para desfazer: isso mudou depois. Edite direto na lista." })} />), /mudou depois/);
});

test("revisão da noite: estados do relatório sem resumo e domingo", () => {
	const failed = html(<ReportCard {...reportProps({ report: report({ status: "failed", summary: null, proposals: [] }), changes: { status: "ready", changes: [] } })} />);
	assert.match(failed, /Não deu certo/);
	assert.match(failed, /Não consegui fazer esta revisão/);
	assert.match(failed, /Nada foi guardado ou mudado\./);
	assert.match(html(<ReportCard {...reportProps({ report: report({ kind: "doctor", slot: "2026-11-01" }) })} />), /Revisão de domingo · 1 de nov\./);
});

test("tudo no idioma da tela: inglês sem sobra de pt-BR", async () => {
	const out = html(
		<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>
			<NotesList {...notesProps({ notes: [note({ source: "sleep" })] })} />
			<RulesList {...rulesProps({ rules: [rule()] })} />
			<ReportCard {...reportProps()} />
		</I18nProvider>,
	);
	for (const text of ["Learned overnight", "When the bot is about to send messages", "Always ask", "Review of Nov 6", "Not now"]) assert.match(out, new RegExp(text));
	assert.doesNotMatch(out, /Aprendido|Sempre perguntar|Revisão|Agora não|Fixar nota/);
});
