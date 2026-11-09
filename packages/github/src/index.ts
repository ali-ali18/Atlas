// Leitura do GitHub (F9): cliente REST, token do dono (instalação do app, OAuth ou PAT do Marketplace), comparação e
// leituras abstraídas da origem das credenciais. Compartilhado pelo motor antigo (agent-runtime, que reexporta) e pelo
// adaptador do v4 no worker. Escrita, hooks e identidade do app para escrita continuam no agent-runtime.
export * from "./client.js";
export * from "./connection-token.js";
export * from "./read-ops.js";
export * from "./app/api.js";
export * from "./app/compare.js";
export * from "./app/credentials.js";
export * from "./app/jwt.js";
export * from "./app/token.js";

export * from "./write/gate.js";
export * from "./write/ops.js";
