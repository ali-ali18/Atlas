import { accountChatgptGate, apiKeyService, chatgptAuthService, SiwcAuthError, type ApiKeyService, type ChatgptGateResolver } from "@workspace/agent-runtime";
import { createApiKeyModelCatalog, createChatgptModelCatalog } from "@workspace/llm";
import { parseModelRef } from "@workspace/shared";

export const chatgptModelCatalog = createChatgptModelCatalog(chatgptAuthService);
/** Catálogos das chaves próprias (Anthropic, OpenCode Go), por usuário. */
export const apiKeyModelCatalog = createApiKeyModelCatalog({ getKey: (userId, provider) => apiKeyService.getKey(userId, provider) });
export type ModelValidation = { status: 400 | 404 | 503; error: string } | { warning?: string };

/** Mesmo escopo do login: a identidade vem da sessão, nunca do corpo. */
export function createProviderModelValidator(
 service: Pick<typeof chatgptAuthService, "status" | "assertOwner"> = chatgptAuthService,
 catalog: Pick<typeof chatgptModelCatalog, "isKnown"> = chatgptModelCatalog,
 /** Plano ligado para o usuário (conta > env). Desligado = erro claro em vez de 404. */
 gate: ChatgptGateResolver = accountChatgptGate(),
 keys: Pick<ApiKeyService, "status"> = apiKeyService,
 keyCatalog: Pick<typeof apiKeyModelCatalog, "isKnown"> = apiKeyModelCatalog,
) {
 return async (userId: string, id: string): Promise<ModelValidation> => {
  let ref;
  try { ref = parseModelRef(id); }
  catch { return { status: 400, error: "Referência de modelo inválida" }; }
  if (ref.provider === "openrouter") return {};
  if (ref.provider === "anthropic" || ref.provider === "opencode-go") {
   // Chave própria do usuário: vale para qualquer conta autenticada, sem o gate do plano ChatGPT.
   const name = ref.provider === "anthropic" ? "Anthropic" : "OpenCode Go";
   try {
    if ((await keys.status(userId, ref.provider)).status !== "connected")
     return { status: 400, error: `Conecte o ${name} em Configurações > Avançado > Provedores` };
    const known = await keyCatalog.isKnown(userId, ref.provider, id);
    if (known === false) return { status: 400, error: `Modelo indisponível no ${name}` };
    return known === null ? { warning: `Catálogo ${name} indisponível; o modelo será validado na execução` } : {};
   } catch {
    return { status: 503, error: `Não foi possível validar a conexão ${name}` };
   }
  }
  try {
   // Não-dono continua 404 (não revela o recurso); só o dono vê o motivo do plano desligado.
   await service.assertOwner(userId);
   if (!(await gate(userId)).enabled)
    return { status: 400, error: "Ative o plano ChatGPT em Configurações → Provedores para usar este modelo" };
   if ((await service.status(userId)).status !== "connected")
    return { status: 400, error: "Conecte o ChatGPT em Configurações → Provedores" };
   const known = await catalog.isKnown(userId, id);
   if (known === false) return { status: 400, error: "Modelo ChatGPT indisponível nesta conta" };
   return known === null ? { warning: "Catálogo ChatGPT indisponível; o modelo será validado na execução" } : {};
  } catch (error) {
   return error instanceof SiwcAuthError && error.status === 404
    ? { status: 404, error: "Não encontrado" }
    : { status: 503, error: "Não foi possível validar a conexão ChatGPT" };
  }
 };
}
export const validateProviderModel = createProviderModelValidator();
