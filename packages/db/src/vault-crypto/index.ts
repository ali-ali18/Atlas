// Cripto do cofre (envelope por usuário, caixa de segredos, TOTP). Entrada própria (`@workspace/db/vault-crypto`):
// sem Prisma nem I/O, para o runtime legado e o adaptador do v4 usarem a mesma implementação.
export * from "./envelope.js";
export * from "./secret-box.js";
export * from "./totp.js";
