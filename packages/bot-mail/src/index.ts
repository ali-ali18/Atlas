// Caixa de e-mail própria do bot (OpenMail): provedor, serviço (ativar, enviar, listar, ler) e verificação de webhook.
// Compartilhado pelo motor antigo (agent-runtime, que reexporta) e pelo adaptador de e-mail do v4 no worker.
export * from "./openmail.js";
export * from "./provider.js";
export * from "./service.js";
