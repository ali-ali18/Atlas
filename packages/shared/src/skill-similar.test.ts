import { describe, expect, it } from "vitest";
import { findSimilarSkill } from "./skill-similar.js";

const doc = (name: string, description: string, botId: string | null = null, status = "active") => ({ name, description, botId, status });

describe("findSimilarSkill", () => {
	const existing = [doc("proposta-comercial-erp", "Monta proposta comercial para o ERP com preço e prazo"), doc("so-do-bot-a", "Procedimento exclusivo", "bot-a"), doc("antiga", "Habilidade antiga", null, "archived")];

	it("acha pelo mesmo nome e pelo nome com os mesmos termos", () => {
		expect(findSimilarSkill(existing, "proposta-comercial-erp", undefined, null)?.name).toBe("proposta-comercial-erp");
		expect(findSimilarSkill(existing, "criar-proposta-comercial-erp", undefined, null)?.name).toBe("proposta-comercial-erp");
	});
	it("não acha uma diferente", () => {
		expect(findSimilarSkill(existing, "relatorio-semanal", "Resumo semanal de vendas por vendedor", null)).toBeUndefined();
	});
	it("habilidade de outro bot não conta; a do próprio bot conta", () => {
		expect(findSimilarSkill(existing, "so-do-bot-a", undefined, "bot-b")).toBeUndefined();
		expect(findSimilarSkill(existing, "so-do-bot-a", undefined, "bot-a")?.name).toBe("so-do-bot-a");
	});
	it("ignora a que não está ativa nem em rascunho", () => {
		expect(findSimilarSkill(existing, "antiga", undefined, null)).toBeUndefined();
	});
});
