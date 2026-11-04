import { describe, expect, it } from "vitest";
import { ownerDecisionHistoryMessage } from "@workspace/shared";
import { trimHistory } from "../hygiene.js";
import { buildTranscriptHistory } from "./transcript.js";
import type { LlmMessage } from "@workspace/llm";

/**
 * Auditoria do PR #131: a recusa gravada como `system` (1) sumia da conversa contínua do v3 e (2) no v1/v2 subia para
 * o bloco de sistema do início em `trimHistory`/`planSummary`, virando regra permanente. A nota agora chega como fala
 * `user` `[runtime]` na posição dela (o carregador do banco formata uma vez).
 */
const NOTE = 'Owner declined: "Enviar esta mensagem". It was not done.';

describe("nota da decisão do dono no histórico", () => {
	it("formato: [runtime] uma vez só, mesmo se o texto já vier com o prefixo", () => {
		expect(ownerDecisionHistoryMessage(NOTE)).toEqual({ role: "user", content: `[runtime] ${NOTE}` });
		expect(ownerDecisionHistoryMessage(`[runtime] ${NOTE}`).content).toBe(`[runtime] ${NOTE}`);
	});

	it("conversa contínua do v3: a nota que veio depois da marca d'água entra na posição dela", () => {
		const history = buildTranscriptHistory({
			transcript: [{ role: "user", content: "Manda o resumo" }, { role: "assistant", content: "Pedi sua aprovação." }],
			after: [{ role: "user", content: "cancela isso" }, ownerDecisionHistoryMessage(NOTE), { role: "user", content: "e o painel?" }],
			objective: "e o painel?",
		});
		expect(history.map((message) => message.content)).toEqual(["Manda o resumo", "Pedi sua aprovação.", "cancela isso", `[runtime] ${NOTE}`]);
	});

	it("v1/v2: trimHistory não promove a nota a system; ela some junto com a cauda antiga", () => {
		const messages: LlmMessage[] = [
			{ role: "system", content: "SOUL" },
			{ role: "user", content: "Manda o resumo" },
			{ role: "assistant", content: "Pedi sua aprovação." },
			ownerDecisionHistoryMessage(NOTE),
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "c" },
		];
		const kept = trimHistory(messages, 3);
		expect(kept.filter((message) => message.role === "system").map((message) => message.content)).toEqual(["SOUL"]);
		expect(kept.some((message) => typeof message.content === "string" && message.content.includes("Owner declined") && message.role === "system")).toBe(false);
		const all = trimHistory(messages, 10);
		expect(all.findIndex((message) => message.content === `[runtime] ${NOTE}`)).toBe(3);
	});
});
