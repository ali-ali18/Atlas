import { describe, expect, it } from "vitest";
import { delegationCue, routeContextGroups } from "./intent-router.js";


describe("grupo data (consulta de dados)", () => {
	it.each(["me dá um relatório das vendas do mês", "lista as contas em aberto", "quanto foi o faturamento por empresa", "quais estão atrasadas?", "how many orders are overdue"])("ativa para: %s", (text) => {
		expect(routeContextGroups({ text }).has("data")).toBe(true);
	});
	it.each(["oi, tudo bem?", "abre o site da prefeitura", "escreve um poema"])("não ativa para: %s", (text) => {
		expect(routeContextGroups({ text }).has("data")).toBe(false);
	});
});

describe("grupo presentations (apresentações)", () => {
	it.each([
		"faz uma apresentação sobre vendas",
		"preciso de slides para a reunião",
		"monta um PowerPoint com o resultado",
		"cria um pitch deck da startup",
		"usa este modelo.pptx",
		"make a presentation about our roadmap",
	])("ativa e traz arquivo e imagens para: %s", (text) => {
		const groups = routeContextGroups({ text });
		expect(groups.has("presentations")).toBe(true);
		expect(groups.has("files")).toBe(true);
		expect(groups.has("images")).toBe(true);
	});
	it.each(["Bom dia", "gera um relatório em PDF", "me manda uma planilha das vendas", "cria um painel de vendas", "escreve um poema"])("não ativa para: %s", (text) => {
		expect(routeContextGroups({ text }).has("presentations")).toBe(false);
	});
});

describe("delegationCue (reserva do Jev de delegação)", () => {
	it.each([
		"pesquisa o preço da canela em 3 fornecedores e compara",
		"compara os planos de 4 bancos para conta PJ",
		"Research two suppliers of cinnamon and compare prices",
		"faz uma cotação em cinco lojas do notebook",
	])("casa: %s", (text) => {
		expect(delegationCue(text)).toBe(true);
	});
	it.each(["oi", "Bom dia", "qual o preço da canela?", "tenho 3 fornecedores cadastrados", "pesquisa o preço da canela", "me lembra às 3 horas"])("não casa: %s", (text) => {
		expect(delegationCue(text)).toBe(false);
	});
});

describe("cards de pergunta e de plano só entram quando servem (política de agir primeiro)", () => {
	it.each(["me lembra de pagar a conta amanhã às 10h", "Bom dia", "lista as contas em aberto", "atualiza a planilha com esses dados"])("sem questionário nem plano: %s", (text) => {
		const groups = routeContextGroups({ text });
		expect(groups.has("questionnaire")).toBe(false);
		expect(groups.has("plan")).toBe(false);
	});
	it("novo agente traz o card de escolhas (a única pergunta do fluxo)", () => {
		expect(routeContextGroups({ text: "cria um agente pra mim" }).has("questionnaire")).toBe(true);
	});
	it("onboarding traz o questionário", () => {
		expect(routeContextGroups({ text: "oi", onboarding: true }).has("questionnaire")).toBe(true);
	});
	it.each(["monta um plano antes de mexer no ERP", "faz um plano de ação para migrar os contatos", "make a plan first"])("pedido de plano traz propose_plan: %s", (text) => {
		expect(routeContextGroups({ text }).has("plan")).toBe(true);
	});
	it.each(["qual o melhor plano de celular?", "compara os planos de 4 bancos"])("plano de produto não é plano de tarefa: %s", (text) => {
		expect(routeContextGroups({ text }).has("plan")).toBe(false);
	});
});
