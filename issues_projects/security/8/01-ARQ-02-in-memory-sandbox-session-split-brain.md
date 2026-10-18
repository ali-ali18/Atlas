# ARQ-02: Sessões de Sandbox em Memória Local (`Map`) entre Múltiplos Processos (Split-Brain)

- **ID:** `ARQ-02`
- **Agravante:** 8 (Alto)
- **Categoria:** Arquitetura / Integridade / Split-Brain
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `packages/sandbox/src/session-store.ts` (linhas 1 a 35)
- `packages/sandbox/src/docker-manager.ts`
- `packages/sandbox/src/reaper.ts`
- `apps/api/src/index.ts`
- `apps/worker/src/processors/agent-run.ts`

---

## 2. Descrição Técnica da Falha

No pacote `@workspace/sandbox`, as sessões ativas dos contêineres Docker são registradas e consultadas a partir de um `Map` local na memória RAM do processo Node.js:

```ts
// packages/sandbox/src/session-store.ts
const sessions = new Map<string, SandboxSessionRecord>();
```

No entanto, o Atlas Agent é uma arquitetura distribuída composta por pelo menos dois processos independentes:
1. `apps/api` (servidor HTTP).
2. `apps/worker` (processador assíncrono BullMQ).

Isso acarreta graves falhas de sincronização e perda de estado:
1. **Invisibilidade entre Processos:** Quando o worker inicia um contêiner de sandbox para executar um run (`runComputerUse`), o registro fica salvo na memória do Worker. A API não enxerga a sessão através de `manager.getSession(sessionId)`.
2. **Reaper Assassino de Contêineres Ativos (Premature Termination):**
   O rotina de limpeza de contêineres (`startSandboxReaper`) roda no processo da API (`apps/api/src/index.ts`). A cada ciclo, o reaper inspeciona os contêineres do Docker e consulta `listSessions()` para saber quais contêineres são conhecidos.
   Como a API não compartilha a memória do Worker (ou se a API foi reiniciada), o reaper considera esses contêineres como "órfãos" e os destrói via `reapOrphans` ou expiração de TTL, derrubando no meio tarefas legítimas do agente em execução.

---

## 3. Impacto de Negócio e Segurança

- Interrupção arbitrária e inexplicável de tarefas do usuário.
- Impossibilidade de escalar horizontalmente a API ou os Workers em múltiplos nós ou réplicas (cluster/Kubernetes/Docker Swarm).

---

## 4. Bibliotecas Externas Recomendadas

- **Redis Hashes / Key-Value com TTL** via **`ioredis`** ou tabela própria no **PostgreSQL** via Prisma.

---

## 5. Passos para Validação pelo QA

1. Subir a API e o Worker.
2. Iniciar um Agent Run longo que execute ações de navegador no Sandbox pelo Worker.
3. Fazer restart do processo da API (`apps/api`).
4. Observar o log do Reaper na API.
5. **Comportamento Inseguro Atual:** O Reaper da API assume que o contêiner do Worker não tem sessão registrada e remove o contêiner, fazendo o run do Worker falhar com erro de conexão no sandbox.
6. **Comportamento Esperado:** O Reaper deve consultar uma fonte central de verdade (Redis/DB) e constatar que a sessão está viva e associada a um lease ativo.

---

## 6. Plano de Ação e Remediação

1. Substituir a implementação do `SessionStore`:
   - Em vez de `new Map()`, usar operações de Redis:
     `HSET sandbox:session:${sessionId}` com `EXPIRE sandbox:session:${sessionId} 1800`.
2. Atualizar o `touchSession` para renovar o TTL diretamente no Redis.
3. Centralizar o Reaper para rodar exclusivamente no Worker ou garantir que ele consulte o Redis compartilhado antes de tomar decisões de encerramento de contêineres.
