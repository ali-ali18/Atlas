# SEC-02: Ausência Total de Autenticação e Autorização nos Endpoints da API

- **ID:** `SEC-02`
- **Agravante:** 10 (Crítico Máximo)
- **Categoria:** Segurança (Acesso Não Autorizado / BOLA / IDOR)
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `apps/api/src/index.ts`
- `apps/api/src/routes/runs.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/bots.ts`
- `apps/api/src/routes/conversations.ts`
- `apps/api/src/routes/memory.ts`
- `apps/api/src/routes/routines.ts`
- `apps/api/src/routes/sandbox.ts`

---

## 2. Descrição Técnica da Falha

A API inteira (`apps/api/src/index.ts`) não possui qualquer camada de autenticação ou autorização.

Qualquer cliente que alcance a porta da API (pela rede local, por proxy exposto ou internet) consegue:
1. Disparar chamadas e criar runs no modelo de IA (`POST /v1/chat`, `POST /v1/runs`, `POST /v1/chat/computer`), consumindo créditos pagos do OpenRouter de forma ilimitada.
2. Listar, ler e apagar todas as conversas e históricos de chat (`GET/POST /v1/conversations/*`).
3. Ler e alterar memórias armazenadas de usuários e robôs (`/v1/memory`).
4. Criar, alterar e excluir robôs (`/v1/bots/*`) e rotinas agendadas (`/v1/routines/*`).
5. Cancelar ou pausar execuções em andamento de outros usuários (`POST /v1/runs/:id/cancel`).
6. Interagir com sessões de Sandbox alheias (`/v1/sandbox/sessions/*`).

---

## 3. Impacto de Negócio e Segurança

- **Financeiro:** Esgotamento imediato do saldo da conta OpenRouter.
- **Privacidade:** Vazamento completo de conversas, credenciais salvas na memória do bot e arquivos capturados por screenshot.
- **Integridade:** Modificação não autorizada de rotinas e exclusão de dados críticos do banco.

---

## 4. Bibliotecas Externas Recomendadas

- **`@hono/bearer-auth`**: Para proteção de endpoints via Bearer token / API Key.
- **`jose`** ou **`hono-jwt`**: Para validação de JWTs padrão OAuth2/OIDC.
- Alternativamente, integração com provedores de autenticação (Auth0, Clerk, Supabase Auth ou NextAuth).

---

## 5. Passos para Validação pelo QA

1. Subir a API (`pnpm dev`).
2. Enviar uma requisição sem qualquer header `Authorization`:
   ```bash
   curl -i -X POST http://localhost:3001/v1/runs \
     -H "Content-Type: application/json" \
     -d '{"messages": [{"role": "user", "content": "Olá"}]}'
   ```
3. **Comportamento Inseguro Atual:** O endpoint responde com código `200` ou `201` e agenda um job de IA normalmente.
4. **Comportamento Esperado:** A API deve responder imediatamente com `401 Unauthorized` com corpo `{ "error": "Unauthorized" }`.

---

## 6. Plano de Ação e Remediação

1. **Middleware Global de Autenticação:**
   - Adicionar middleware em `apps/api/src/index.ts`:
     ```ts
     app.use('/v1/*', authMiddleware);
     ```
   - Liberar apenas rotas públicas explícitas (como `/health` e os webhooks com sua validação própria em `/webhooks/*`).
2. **Contexto de Usuário:**
   - Popular o contexto do Hono (`c.set('userId', token.userId)`) para vincular cada operação ao respectivo usuário autenticado.
3. **Proteção Contra IDOR:**
   - Em todas as rotas que recebem `id` (ex: botId, conversationId, runId), verificar se o recurso realmente pertence ao `userId` do token.
