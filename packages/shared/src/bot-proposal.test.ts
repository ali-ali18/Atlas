import { describe, expect, it } from "vitest";
import {
	isBareBotCreateRequest,
	parseBotProposal,
	parseBotProposalCard,
	parseBotProposalEdits,
	resolveBotProposalColor,
} from "./bot-proposal.js";
import { isConversationCardRole, parseConversationCard, serializeConversationCard } from "./skill-card.js";

const base = { proposalId: "bot-run-1", name: "Estoquinho", description: "Cuida do estoque.", color: "blue", shape: "hex" };

describe("bot-proposal", () => {
  it("normaliza cor por id/nome/hex e cai nos padrões quando falta", () => {
    expect(resolveBotProposalColor("Blue")).toBe("#1084FE");
    expect(resolveBotProposalColor("#1084fe")).toBe("#1084FE");
    expect(resolveBotProposalColor("Rosa")).toBe("#FF309B");
    expect(resolveBotProposalColor("neon")).toBeNull();
    const data = parseBotProposal({ ...base, color: undefined, shape: "nao-existe" });
    expect(data).toMatchObject({ color: "#FF6700", shape: "blob", status: "pending", skills: [], model: null, firstTask: null });
  });

  it("recusa nome/papel vazios ou longos e skills fora do formato", () => {
    expect(parseBotProposal({ ...base, name: "" })).toBeNull();
    expect(parseBotProposal({ ...base, name: "x".repeat(41) })).toBeNull();
    expect(parseBotProposal({ ...base, description: "" })).toBeNull();
    expect(parseBotProposal({ ...base, skills: ["ok-skill", "Ruim Nome", 3] })?.skills).toEqual(["ok-skill"]);
  });

  it("o card persistido passa pelo parseConversationCard e pelo papel da timeline", () => {
    const card = parseBotProposalCard({ v: 1, kind: "bot-proposal", ...base });
    expect(card).not.toBeNull();
    expect(isConversationCardRole("bot-proposal")).toBe(true);
    const back = parseConversationCard(serializeConversationCard(card!));
    expect(back).toMatchObject({ kind: "bot-proposal", name: "Estoquinho", color: "#1084FE" });
  });

  it("edições: só nome e papel válidos", () => {
    expect(parseBotProposalEdits(undefined)).toEqual({});
    expect(parseBotProposalEdits({ name: " Novo ", description: " Papel " })).toEqual({ name: "Novo", description: "Papel" });
    expect(parseBotProposalEdits({ name: "" })).toBeNull();
    expect(parseBotProposalEdits("x")).toBeNull();
  });

  it("guarda de pedido vago é estreita", () => {
    expect(isBareBotCreateRequest("cria um agente pra mim")).toBe(true);
    expect(isBareBotCreateRequest("Quero criar um bot")).toBe(true);
    expect(isBareBotCreateRequest("cria um agente que responde meus clientes no WhatsApp")).toBe(false);
    expect(isBareBotCreateRequest("o agente de vendas está lento")).toBe(false);
  });
});
