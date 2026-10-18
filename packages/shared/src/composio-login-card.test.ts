import { expect, it } from "vitest";
import { parseConversationCard } from "./skill-card.js";
it("card de conexão do Linear mantém toolkit após carregar histórico", () => {
  const card = { v: 1, kind: "login", loginId: "login-1", site: "linear", url: "https://composio.dev", status: "pending", composioToolkit: "linear" };
  expect(parseConversationCard(JSON.stringify(card))).toEqual(card);
});

it("card antigo mantém login VM e toolkit inválido não vira comando de popup", () => {
 const card = { v: 1, kind: "login", loginId: "old", site: "linear.app", url: "https://linear.app/home", status: "pending" };
 expect(parseConversationCard(JSON.stringify(card))).toEqual(card);
 expect(parseConversationCard(JSON.stringify({ ...card, composioToolkit: "../../linear" }))).toEqual(card);
});

it("card de conexão nativo mantém ícone, nome e descrição; ícone perigoso vira null", () => {
	const connector = { kind: "native", id: "github", name: "GitHub", description: "Repositórios", icon: "/connectors/github.svg", reconnect: true };
	const card = { v: 1, kind: "login", loginId: "login-2", site: "GitHub", url: "https://github.com", status: "pending", connector };
	expect(parseConversationCard(JSON.stringify(card))).toEqual(card);
	const unsafe = parseConversationCard(JSON.stringify({ ...card, connector: { ...connector, icon: "javascript:x" } }));
	expect(unsafe).toMatchObject({ connector: { icon: null } });
});
