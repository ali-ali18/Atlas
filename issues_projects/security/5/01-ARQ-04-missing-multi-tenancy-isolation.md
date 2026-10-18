# ARQ-04: Falta de Isolamento Multi-Tenancy Nativo (`DEFAULT_USER_ID = "default"`)

- **ID:** `ARQ-04`
- **Agravante:** 5 (Moderado)
- **Categoria:** Arquitetura / Modelagem de Dados / Privacidade
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `packages/db/prisma/schema.prisma`
- `packages/db/src/routines.ts`
- `apps/api/src/routes/routines.ts`
- `apps/api/src/routes/skills.ts`
- `apps/api/src/routes/memory.ts`
- `apps/api/src/routes/bots.ts`
- `apps/api/src/routes/conversations.ts`

---

## 2. Descrição Técnica da Falha

No design atual do banco de dados e dos serviços de backend, o identificador de usuário (`userId`) está fixado como uma constante estática:

```ts
const DEFAULT_USER_ID = "default";
```

### Problemas estruturais identificados no Prisma Schema:
1. As tabelas `Conversation`, `Bot`, `Section` e `UserSettings` sequer possuem uma coluna `userId`.
2. Todos os bots criados, conversas abertas e rotinas salvas residem em um namespace global compartilhado.
3. Se a aplicação for colocada em produção para atendimento de mais de um usuário, não há nenhuma barreira lógica de isolamento de dados no banco: o Usuário B pode listar e interagir com as conversas e bots do Usuário A.
4. Para as tabelas que possuem `userId` (como `memory_entries` e `skills`), quase todas as chamadas na API injetam a string literal `"default"`.

---

## 3. Impacto de Negócio e Segurança

- Impossibilidade de operação multi-tenant real (B2B SaaS ou múltiplos usuários corporativos).
- Vazamento cruzado de dados entre usuários (Cross-Tenant Data Leak).
- Necessidade de refatoração massiva futura em migrations e contratos de API se não corrigido precocemente.

---

## 4. Bibliotecas Externas Recomendadas

- Nenhuma biblioteca externa necessária. Trata-se de alteração arquitetural de modelagem relacional via Prisma e migrations SQL.

---

## 5. Passos para Validação pelo QA

1. Inspecionar o arquivo `packages/db/prisma/schema.prisma`.
2. Verificar se o modelo `Conversation` possui relacionamento com usuário:
   ```prisma
   model Conversation {
     id String @id
     // falta: userId String
   }
   ```
3. Criar uma conversa pela API e verificar se qualquer outro cliente consegue listar essa mesma conversa.

---

## 6. Plano de Ação e Remediação

1. **Atualização do Prisma Schema:**
   - Adicionar o campo `userId String` nas tabelas `Conversation`, `Bot`, `Section`, `UserSettings`.
   - Adicionar índices compostos `@@index([userId, createdAt])`.
2. **Remover Constantes Hardcoded:**
   - Excluir `const DEFAULT_USER_ID = "default"`.
   - Extrair o `userId` obrigatoriamente do token JWT/sessão validado no middleware de autenticação (`c.get("userId")`).
3. **Migração de Dados:**
   - Criar script de migração do Prisma (`prisma migrate dev --name add_user_id_multi_tenancy`) atribuindo os dados legados para um usuário administrador inicial.
