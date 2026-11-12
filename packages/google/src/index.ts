// Cliente do Google (Agenda, Gmail, Drive, Planilhas): chamada REST autenticada, erros acionáveis e token OAuth fresco do
// conector do dono. Compartilhado pelo motor antigo (agent-runtime, que reexporta) e pelos adaptadores do v4 no worker.
export * from "./auth-required.js";
export * from "./google-api.js";
export * from "./oauth-token.js";
