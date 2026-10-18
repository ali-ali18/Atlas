# TIP-03: Inconsistência de Contratos nos DTOs Compartilhados (`null` vs `undefined`)

- **ID:** `TIP-03`
- **Agravante:** 1 (Trivial / Estilo)
- **Categoria:** Tipagem / Ergonomia de Código
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `packages/shared/src/chat.ts`
- `packages/shared/src/runs.ts`
- `packages/db/src/runs.ts`
- `apps/worker/src/processors/agent-run.ts`

---

## 2. Descrição Técnica da Falha

No pacote `@workspace/shared`, diversas interfaces de domínio e transporte misturam tipos opcionais com valores nulos de forma inconsistente:

- Em `ChatMessage`:
  `botId?: string | null; conversationId?: string | null;`
- Em `CreateAgentRunRequest`:
  `botId?: string; conversationId?: string;`
- Em retornos do Prisma:
  `row.botId` é `string | null`.

Essa divergência obriga os desenvolvedores a espalharem operadores de coalescência repetitivos por toda a base de código:
```ts
userId: userId ?? "default",
botId: botId ?? undefined,
conversationId: conversationId ?? undefined,
```

Em JSON sobre HTTP, a ausência de um campo (`undefined`) é omitida, enquanto `null` é transmitido como valor literal. Essa mistura de convenções gera ruído em testes, dificulta a tipagem estrita do TypeScript e é propensa a bugs quando checagens usam `=== undefined` ou `=== null` de forma exclusiva.

---

## 3. Impacto de Negócio e Segurança

- Baixo / Qualidade de código: Aumento de complexidade ciclomática e ruído visual no código fonte.

---

## 4. Bibliotecas Externas Recomendadas

- Nenhuma biblioteca externa necessária. Ajuste de convenção de tipos TypeScript no workspace.

---

## 5. Passos para Validação pelo QA

1. Executar `pnpm typecheck` no monorepo e buscar por ocorrências de `?? undefined` ou `?? null` entre camadas de shared e db.

---

## 6. Plano de Ação e Remediação

1. **Adotar Convenção Única:**
   - DTOs de entrada e saída de API usam campos opcionais (`field?: string`).
   - O repositório Prisma é responsável por mapear `null` do banco para `undefined` ao converter para as entidades compartilhadas de domínio.
