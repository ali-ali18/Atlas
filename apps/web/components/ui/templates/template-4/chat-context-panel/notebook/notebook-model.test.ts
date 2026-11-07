import assert from "node:assert/strict";
import test from "node:test";
import type { SleepStoredProposal } from "@workspace/shared";
import { AtlasApiError } from "@/lib/atlas-api";
import { loadMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translator";
import { change, note, NOW, report, rule } from "./fixtures";

const en = createTranslator("en-US", await loadMessages("en-US"));
const es = createTranslator("es-ES", await loadMessages("es-ES"));
import {
	canUndoChange,
	changePhrase,
	noteErrorMessage,
	noteMeta,
	noteOriginLabel,
	noteScopeLabel,
	openProposals,
	proposalView,
	reportChanges,
	reportSummary,
	reportTitle,
	ruleEffectPhrase,
	ruleErrorMessage,
	ruleMatchLabel,
	ruleSourceLabel,
	sortNotes,
	undoErrorMessage,
	validateNoteDraft,
} from "./notebook-model";

const api = (status: number, code?: string) => new AtlasApiError("x", status, code ? { code } : undefined);

test("notas: fixadas primeiro, depois a mais recente; não muda a lista original", () => {
	const list = [note({ id: "a", updatedAt: "2026-11-01T00:00:00Z" }), note({ id: "b", updatedAt: "2026-11-06T00:00:00Z" }), note({ id: "c", pinned: true, updatedAt: "2026-10-01T00:00:00Z" })];
	assert.deepEqual(sortNotes(list).map((item) => item.id), ["c", "b", "a"]);
	assert.deepEqual(list.map((item) => item.id), ["a", "b", "c"]);
});

test("origem e alcance da nota em frase simples", () => {
	assert.equal(noteOriginLabel("owner"), "Você");
	assert.equal(noteOriginLabel("agent"), "O bot");
	assert.equal(noteOriginLabel("sleep"), "Aprendido à noite");
	assert.equal(noteScopeLabel({ botId: null }, "b1"), "Vale para todos os bots");
	assert.equal(noteScopeLabel({ botId: "b1" }, "b1"), "Só deste bot");
	assert.equal(noteScopeLabel({ botId: "b2" }, "b1"), "Só de outro bot");
	assert.equal(noteMeta(note({ source: "sleep", botId: "b1" }), "b1", NOW), "Aprendido à noite · Só deste bot · há 2 h");
});

test("validação do rascunho: vazio e acima do limite viram frase, sem ir ao servidor", () => {
	assert.equal(validateNoteDraft({ title: "  ", body: "x" }), "Dê um título à nota.");
	assert.equal(validateNoteDraft({ title: "t", body: " \n " }), "Escreva o texto da nota.");
	assert.match(validateNoteDraft({ title: "t".repeat(121), body: "x" }) ?? "", /até 120 caracteres/);
	assert.match(validateNoteDraft({ body: "x".repeat(20_001), title: "t" }) ?? "", /até 20000 caracteres/);
	assert.equal(validateNoteDraft({ title: "t", body: "x".repeat(20_000) }), null);
});

test("conflitos do 409 da nota: limite, repetida e mudou depois; nunca código nem status", () => {
	assert.match(noteErrorMessage(api(409, "limit")), /caderno está cheio \(500 notas\)/);
	assert.equal(noteErrorMessage(api(409, "duplicate")), "Já existe uma nota com esse mesmo texto.");
	assert.match(noteErrorMessage(api(409, "conflict")), /mudou enquanto você mexia/);
	assert.match(noteErrorMessage(api(409)), /mudou enquanto você mexia/);
	assert.equal(noteErrorMessage(api(404)), "Essa nota não existe mais.");
	assert.equal(noteErrorMessage(new Error("boom 500")), "Não consegui guardar a nota. Tente de novo.");
	for (const text of [noteErrorMessage(api(409, "duplicate")), noteErrorMessage(api(500))]) assert.doesNotMatch(text, /409|500|duplicate|code/i);
});

test("regras: nome interno de ferramenta nunca aparece (nem com _ nem com espaço); desconhecido é omitido", () => {
	assert.equal(ruleMatchLabel("notion_fetch_page_v2"), null, "ação que não sabemos dizer some; a classe já explica");
	assert.equal(ruleMatchLabel("  "), null);
	for (const match of ["drive_list_files", "gmail_send_email", "mcp__gmail__search_threads", "calendar_create_event", "stripe_refund_charge", "fetch_url"]) {
		for (const translator of [undefined, en, es]) {
			const label = ruleMatchLabel(match, translator) ?? "";
			assert.doesNotMatch(label, /_/, match);
			assert.doesNotMatch(label, /\b(list files|send email|search threads|create event|refund charge|fetch url|list_files)\b/i, match);
		}
	}
});

test("regras: o efeito vira palavras, o alvo só aparece quando restringe, 422 vira frase", () => {
	assert.equal(ruleEffectPhrase("send"), "enviar mensagens");
	assert.equal(ruleEffectPhrase("money"), "gastar dinheiro");
	assert.equal(ruleEffectPhrase(null), "fazer qualquer coisa");
	assert.equal(ruleMatchLabel("*"), null);
	assert.equal(ruleMatchLabel("gmail_send_email"), "Só para: enviar e-mail pelo Gmail");
	assert.equal(ruleMatchLabel("mcp__google_drive__list_recent_files"), "Só para: listar arquivos do Drive");
	assert.equal(ruleMatchLabel("gmail_send_email", en), "Only for: sending email through Gmail");
	assert.equal(ruleSourceLabel(rule({ source: "owner", learnedAt: null }), NOW), "Você definiu");
	assert.equal(ruleSourceLabel(rule(), NOW), "O bot aprendeu · há 3 dias");
	assert.match(ruleErrorMessage(api(422)), /regras demais/);
	assert.match(ruleErrorMessage(api(409)), /As regras mudaram/);
	assert.equal(ruleErrorMessage(api(404)), "Essa regra não existe mais.");
	assert.equal(ruleErrorMessage(api(500)), "Não consegui guardar a regra. Tente de novo.");
});

test("relatório: título pela data do dia local, resumo do servidor ou frase pelo estado", () => {
	assert.equal(reportTitle(report({ slot: "2026-11-06" })), "Revisão de 6 de nov.");
	assert.equal(reportTitle(report({ kind: "doctor", slot: "2026-11-01" })), "Revisão de domingo · 1 de nov.");
	assert.match(reportSummary(report()), /^Guardei 1 fato/);
	assert.equal(reportSummary(report({ summary: null, status: "failed" })), "Não consegui fazer esta revisão. Tento de novo na próxima noite.");
	assert.equal(reportSummary(report({ summary: "  ", status: "skipped" })), "Não houve conversa para revisar.");
});

test("mudanças em frase: fato ou nota, guardou/mudou/apagou; desfazer só do que não foi desfeito", () => {
	assert.equal(changePhrase(change()), "Guardou: Prefere café sem açúcar");
	assert.equal(changePhrase(change({ action: "remove", before: "Mora em Recife", after: null })), "Apagou: Mora em Recife");
	assert.equal(changePhrase(change({ target: "note", afterNote: { title: "Roteiro de Lisboa", pinned: false }, after: "texto" })), "Guardou a nota “Roteiro de Lisboa”");
	assert.equal(changePhrase(change({ target: "note", action: "replace", beforeNote: { title: "Velha", pinned: false }, afterNote: null })), "Mudou a nota “Velha”");
	assert.match(changePhrase(change({ after: "x".repeat(400) })), /…$/);
	assert.equal(canUndoChange(change()), true);
	assert.equal(canUndoChange(change({ undoneAt: "2026-11-07T03:00:00Z" })), false);
	assert.equal(canUndoChange(change({ undoOfId: "c0" })), false);
	assert.deepEqual(reportChanges([change({ id: "a" }), change({ id: "b", undoOfId: "a" })]).map((item) => item.id), ["a"]);
});

test("desfazer: 409 stale|duplicate|limit|already_undone em frase simples", () => {
	assert.match(undoErrorMessage(api(409, "stale")), /mudou depois/);
	assert.match(undoErrorMessage(api(409, "duplicate")), /algo igual/);
	assert.match(undoErrorMessage(api(409, "limit")), /Não coube/);
	assert.match(undoErrorMessage(api(409, "already_undone")), /já tinha sido desfeito/);
	assert.match(undoErrorMessage(api(409, "inventado")), /Não consegui desfazer/);
	assert.match(undoErrorMessage(api(500, "stale")), /Não consegui desfazer/);
});

test("propostas: habilidade, caso de falha e achado do doctor sem ids nem classes internas", () => {
	const proposals: SleepStoredProposal[] = [
		report().proposals[0]!,
		{ id: "eval:1", kind: "eval_case", status: "open", runId: "run_9", failureClass: "model.loop", evidence: ["e"], input: "Resuma o e-mail" },
		{ id: "doc:1", kind: "doctor", status: "dismissed", finding: { type: "conflict", subject: "memory", ids: ["m1", "m2"], reason: "Duas memórias dizem cidades diferentes." } },
	];
	const views = proposals.map((proposal) => proposalView(proposal));
	assert.deepEqual(views[0], { id: "skill:2026-11-06:planilha", badge: "Habilidade", title: "Conferir planilha de vendas", detail: "Abrir a planilha, somar a coluna do mês e avisar se passar da meta.", dismissed: false });
	assert.equal(views[1]?.badge, "Falha para testar");
	assert.equal(views[1]?.title, "Uma tarefa deu errado: “Resuma o e-mail”");
	assert.deepEqual([views[2]?.badge, views[2]?.dismissed], ["Contradição", true]);
	for (const view of views) assert.doesNotMatch(JSON.stringify(view), /model\.loop|run_9|m1/);
	assert.equal(openProposals({ proposals }).length, 2);
});

test("em inglês e espanhol as mesmas frases existem (sem cair no pt-BR)", async () => {
	assert.equal(noteOriginLabel("sleep", en), "Learned overnight");
	assert.equal(ruleEffectPhrase("send", es), "enviar mensajes");
	assert.equal(reportTitle(report(), en), "Review of Nov 6");
	assert.equal(changePhrase(change(), en), "Saved: Prefere café sem açúcar");
	assert.match(noteErrorMessage(api(409, "limit"), es), /cuaderno está lleno/);
});
