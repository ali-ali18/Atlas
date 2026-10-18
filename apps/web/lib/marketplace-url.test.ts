import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketplaceSearch, parseMarketplaceLocation } from "./marketplace-url";

test("endereço do marketplace: seção, item e valores desconhecidos", () => {
  assert.equal(parseMarketplaceLocation(""), null);
  assert.equal(parseMarketplaceLocation("?settings=bots"), null);
  assert.deepEqual(parseMarketplaceLocation("?marketplace=apps"), { section: "apps", item: null });
  assert.deepEqual(parseMarketplaceLocation("?marketplace=habilidades&item=roblox"), { section: "habilidades", item: "roblox" });
  assert.deepEqual(parseMarketplaceLocation("?marketplace=agentes&item=dev-roblox"), { section: "agentes", item: "dev-roblox" });
  // link antigo e valor inválido caem em seções que existem
  assert.deepEqual(parseMarketplaceLocation("?marketplace=skills"), { section: "habilidades", item: null });
  assert.deepEqual(parseMarketplaceLocation("?marketplace=1"), { section: "conectores", item: null });
  assert.deepEqual(parseMarketplaceLocation("?marketplace=conectores&item=c.123"), { section: "conectores", item: "c.123" });
});

test("montar a query troca só os parâmetros do marketplace e preserva o resto", () => {
  assert.equal(buildMarketplaceSearch("", { section: "apps", item: null }), "?marketplace=apps");
  assert.equal(buildMarketplaceSearch("?settings=bots", { section: "agentes", item: "x" }), "?settings=bots&marketplace=agentes&item=x");
  assert.equal(buildMarketplaceSearch("?marketplace=apps&item=y&settings=bots", { section: "habilidades", item: null }), "?settings=bots&marketplace=habilidades");
  assert.equal(buildMarketplaceSearch("?marketplace=apps&item=y", null), "");
  assert.equal(buildMarketplaceSearch("?marketplace=apps&settings=bots", null), "?settings=bots");
});
