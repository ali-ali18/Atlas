import { describe, expect, it } from "vitest";
import { routeContextGroups } from "./intent-router.js";


describe("grupo data (consulta de dados)", () => {
	it.each(["me dá um relatório das vendas do mês", "lista as contas em aberto", "quanto foi o faturamento por empresa", "quais estão atrasadas?", "how many orders are overdue"])("ativa para: %s", (text) => {
		expect(routeContextGroups({ text }).has("data")).toBe(true);
	});
	it.each(["oi, tudo bem?", "abre o site da prefeitura", "escreve um poema"])("não ativa para: %s", (text) => {
		expect(routeContextGroups({ text }).has("data")).toBe(false);
	});
});
