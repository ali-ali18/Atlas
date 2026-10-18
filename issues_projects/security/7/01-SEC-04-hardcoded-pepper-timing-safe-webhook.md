# SEC-04: Pepper de Webhooks com Fallback Público Hardcoded e Comparação Vulnerável a Timing Attack

- **ID:** `SEC-04`
- **Agravante:** 7 (Médio-Alto)
- **Categoria:** Segurança / Criptografia
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `packages/db/src/routines.ts` (linhas 20 a 85)
- `apps/api/src/webhooks/dispatch.ts` (linhas 40 a 50)

---

## 2. Descrição Técnica da Falha

Existem duas vulnerabilidades criptográficas na gestão de segredos dos webhooks:

1. **Fallback Hardcoded de Pepper Público:**
   ```ts
   // packages/db/src/routines.ts
   const DEFAULT_HOOK_PEPPER = "atlas-dev-hook-pepper";
   function hookPepper(): string {
     return process.env.ATLAS_HOOK_PEPPER?.trim() || DEFAULT_HOOK_PEPPER;
   }
   ```
   Se a variável de ambiente `ATLAS_HOOK_PEPPER` não estiver configurada no arquivo de ambiente do servidor, todos os segredos de webhook de todos os clientes são assinados com essa string estática e pública no repositório. Qualquer atacante com acesso ao banco ou logs pode facilmente forjar ou quebrar os segredos por brute-force/rainbow tables.

2. **Comparação Manual de Strings Vulnerável a Timing Attack:**
   ```ts
   // packages/db/src/routines.ts
   export function verifyHookSecret(secret: string, secretHash: string): boolean {
     const got = hashHookSecret(secret);
     if (got.length !== secretHash.length) return false;
     let mismatch = 0;
     for (let i = 0; i < got.length; i++) {
       mismatch |= got.charCodeAt(i) ^ secretHash.charCodeAt(i);
     }
     return mismatch === 0;
   }
   ```
   Apesar da intenção de tempo constante com XOR, a checagem preliminar `if (got.length !== secretHash.length) return false;` e o acesso via `charCodeAt` no motor V8 sofrem com otimizações JIT que podem vazar diferenças sutis de tempo (Timing Attack).
   Além disso, o hash é gerado com `createHash("sha256").update(`${pepper}:${secret}`)` simples em vez de HMAC (`createHmac`).

---

## 3. Impacto de Negócio e Segurança

- Forjamento de requisições de webhook para acionamento indevido de rotinas corporativas.
- Quebra de confidencialidade de segredos de integração de terceiros.

---

## 4. Bibliotecas Externas Recomendadas

- Módulo nativo auditado do Node.js: **`node:crypto`** (`crypto.createHmac` e `crypto.timingSafeEqual`).

---

## 5. Passos para Validação pelo QA

1. Subir a API sem configurar a variável de ambiente `ATLAS_HOOK_PEPPER`.
2. Criar uma rotina com trigger do tipo webhook.
3. Verificar o hash gerado no banco de dados.
4. **Comportamento Inseguro Atual:** O sistema sobe silenciosamente usando o pepper inseguro `atlas-dev-hook-pepper`.
5. **Comportamento Esperado:** Se `NODE_ENV === "production"`, a inicialização deve falhar imediatamente com erro claro exigindo uma chave de pepper segura.

---

## 6. Plano de Ação e Remediação

1. **Validação Obrigatória em Produção:**
   ```ts
   if (process.env.NODE_ENV === "production" && !process.env.ATLAS_HOOK_PEPPER) {
     throw new Error("ATLAS_HOOK_PEPPER environment variable is required in production!");
   }
   ```
2. **Utilizar HMAC e `timingSafeEqual` Nativo:**
   ```ts
   import { createHmac, timingSafeEqual } from "node:crypto";

   export function hashHookSecret(secret: string): string {
     return createHmac("sha256", hookPepper()).update(secret).digest("hex");
   }

   export function verifyHookSecret(secret: string, secretHash: string): boolean {
     const candidate = Buffer.from(hashHookSecret(secret), "utf8");
     const stored = Buffer.from(secretHash, "utf8");
     if (candidate.length !== stored.length) return false;
     return timingSafeEqual(candidate, stored);
   }
   ```
