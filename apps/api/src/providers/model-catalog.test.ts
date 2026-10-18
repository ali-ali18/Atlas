import assert from "node:assert/strict";
import { test } from "node:test";
import { SiwcAuthError } from "@workspace/agent-runtime";
import { createProviderModelValidator } from "./model-catalog.js";

const enabled = async () => ({ enabled: true, source: "user" as const });
/** Só o dono passa; qualquer outro usuário recebe o 404 do serviço. */
const ownerOnly = (owner: string) => async (userId: string) => {
 if (userId !== owner) throw new SiwcAuthError("not_found", 404);
};
const connected = { provider: "chatgpt", status: "connected", accountEmail: null, updatedAt: null, lastLimitAt: null } as const;
const mustNotRun = async () => { throw new Error("must not run"); };

test("validação mantém ids antigos sem acessar credenciais SIWC", async () => {
 const validate = createProviderModelValidator({ status: mustNotRun, assertOwner: mustNotRun }, { isKnown: mustNotRun }, enabled);
 assert.deepEqual(await validate("b", "openai/gpt-4o-mini"), {});
 assert.equal((await validate("a", "chatgpt/path/invalid") as {status:number}).status, 400);
});
test("dono conectado: modelo conhecido aceita; catálogo fora avisa; desconhecido rejeita", async () => {
 let known: boolean | null = true;
 const calls: string[] = [];
 const validate = createProviderModelValidator({ assertOwner: ownerOnly("a"), status: async userId => {
  calls.push(userId);
  if (userId !== "a") throw new SiwcAuthError("not_found", 404);
  return connected;
 } }, { isKnown: async (userId) => { calls.push(`catalog:${userId}`); return known; } }, enabled);
 assert.deepEqual(await validate("a", "chatgpt/luna"), {});
 known = null; assert.ok("warning" in await validate("a", "chatgpt/luna"));
 known = false; assert.equal((await validate("a", "chatgpt/luna") as {status:number}).status, 400);
 assert.equal((await validate("b", "chatgpt/luna") as {status:number}).status, 404);
 assert.ok(!calls.includes("catalog:b"));
});
test("desconectado impede escrita sem consultar o catálogo", async () => {
 const validate = createProviderModelValidator({ assertOwner: ownerOnly("a"), status: async () => ({ ...connected, status: "needs_login" }) }, { isKnown: mustNotRun }, enabled);
 const result = await validate("a", "chatgpt/luna") as { status: number; error: string };
 assert.equal(result.status, 400);
 assert.match(result.error, /Conecte o ChatGPT/);
});
test("plano desligado para o dono: erro claro em pt-BR, sem consultar status nem catálogo", async () => {
 const validate = createProviderModelValidator(
  { assertOwner: ownerOnly("a"), status: mustNotRun },
  { isKnown: mustNotRun },
  async () => ({ enabled: false, source: "default" }),
 );
 const result = await validate("a", "chatgpt/luna") as { status: number; error: string };
 assert.equal(result.status, 400);
 assert.match(result.error, /Ative o plano ChatGPT em Configurações/);
 assert.deepEqual(await validate("a", "openai/gpt-4o-mini"), {});
});
test("plano ligado + conectado: aceita (nada de erro)", async () => {
 const validate = createProviderModelValidator(
  { assertOwner: ownerOnly("a"), status: async () => connected },
  { isKnown: async () => true },
  async () => ({ enabled: true, source: "user" }),
 );
 assert.deepEqual(await validate("a", "chatgpt/luna"), {});
});
test("B não-dono: 404 mesmo com o plano desligado (não revela o recurso) e nunca chega ao catálogo", async () => {
 const catalogCalls: string[] = [];
 const validate = createProviderModelValidator(
  { assertOwner: ownerOnly("a"), status: async () => connected },
  { isKnown: async (userId) => { catalogCalls.push(userId); return true; } },
  async (userId) => ({ enabled: userId === "a", source: "user" }),
 );
 assert.deepEqual(await validate("a", "chatgpt/luna"), {});
 assert.equal((await validate("b", "chatgpt/luna") as { status: number }).status, 404);
 assert.deepEqual(catalogCalls, ["a"]);
});
