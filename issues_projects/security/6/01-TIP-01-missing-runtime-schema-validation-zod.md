# TIP-01: Ausência de Validação de Schemas em Tempo de Execução (Runtime Type Validation)

- **ID:** `TIP-01`
- **Agravante:** 6 (Médio)
- **Categoria:** Tipagem / Qualidade de Código / Robustez
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `apps/api/src/routes/sandbox.ts`
- `apps/api/src/routes/runs.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/chat/parse.ts`
- `apps/api/src/routes/bots.ts`
- `apps/api/src/routes/conversations.ts`
- `apps/api/src/routes/memory.ts`
- `apps/api/src/routes/routines.ts`
- `apps/api/src/routes/settings.ts`

---

## 2. Descrição Técnica da Falha

Em praticamente todas as rotas da API, a validação de entrada de dados do cliente (JSON body e query params) é feita manualmente através de dezenas de funções imperativas artesanais:

```ts
function parseAddInput(body: unknown): MemoryAddInput | null {
  if (typeof body !== "object" || body === null) return null;
  const { target, content, botId } = body as { target?: unknown; content?: unknown; botId?: unknown; };
  // checagens manuais de typeof string, includes, trim...
}
```

### Problemas desse padrão:
1. **Frágil e Sujeito a Erros Humanos:** Fácil esquecer de validar limites de tamanho (`minLength`, `maxLength`), limites numéricos (`min`, `max`), valores NaN, tipos de array e propriedades desconhecidas.
2. **Duplicação de Código:** O projeto mantém interfaces TypeScript em `@workspace/shared` e reescreve funções de parsing correspondentes em cada arquivo de rota.
3. **Respostas de Erro Inconsistentes:** Cada rota retorna um formato de erro diferente (algumas retornam `{ error: "Invalid body" }`, outras `{ error: "Invalid JSON" }`, outras `{ ok: false, error: "..." }`).
4. **Ausência de Type Narrowing Seguro:** O código faz type assertion forçado `body as Record<string, unknown>`, o que desativa a segurança do TypeScript.

---

## 3. Impacto de Negócio e Segurança

- Falhas em tempo de execução (`TypeError: cannot read property of undefined`).
- Injeção de propriedades poluídas em objetos que são repassados ao banco de dados ou worker.

---

## 4. Bibliotecas Externas Recomendadas

- **`zod`** (padrão ouro em TypeScript para definição de schemas e inferência automática de tipos).
- **`@hono/zod-validator`** (middleware nativo do ecossistema Hono para validação automática de headers, params, query e json body).

---

## 5. Passos para Validação pelo QA

1. Enviar um JSON com payload fora do esperado para `/v1/runs`:
   ```bash
   curl -X POST http://localhost:3001/v1/runs \
     -H "Content-Type: application/json" \
     -d '{"messages": [{"role": "hacker", "content": 12345}]}'
   ```
2. **Comportamento Atual:** Dependendo da rota, o parser manual pode deixar passar ou estourar exceções não tratadas no servidor.
3. **Comportamento Esperado:** Resposta padronizada `400 Bad Request` com a lista exata dos campos inválidos (`messages[0].role: Invalid enum value`, `messages[0].content: Expected string, received number`).

---

## 6. Plano de Ação e Remediação

1. **Adicionar Zod ao Workspace:**
   - Adicionar `zod` em `@workspace/shared` e `@hono/zod-validator` em `apps/api`.
2. **Definir Schemas Únicos:**
   ```ts
   // packages/shared/src/schemas/chat.ts
   import { z } from "zod";

   export const ChatMessageSchema = z.object({
     role: z.enum(["system", "user", "assistant", "tool"]),
     content: z.string().min(1).max(50000),
   });

   export const CreateRunRequestSchema = z.object({
     messages: z.array(ChatMessageSchema).min(1),
     model: z.string().optional(),
     conversationId: z.string().uuid().optional(),
     botId: z.string().optional(),
     maxSteps: z.number().int().min(1).max(100).optional(),
   });

   export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
   ```
3. **Usar nas Rotas Hono:**
   ```ts
   import { zValidator } from "@hono/zod-validator";

   app.post("/v1/runs", zValidator("json", CreateRunRequestSchema), async (c) => {
     const data = c.req.valid("json"); // 100% tipado e seguro!
     // ...
   });
   ```
