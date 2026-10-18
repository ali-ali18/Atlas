# ARQ-03: Conexão Redis Única Compartilhada entre Workers e Queues BullMQ

- **ID:** `ARQ-03`
- **Agravante:** 8 (Alto)
- **Categoria:** Arquitetura / Desempenho / Confiabilidade I/O
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `packages/queue/src/connection.ts`
- `apps/worker/src/index.ts` (linhas 40 a 115)
- `apps/api/src/index.ts` (linhas 40 a 55)

---

## 2. Descrição Técnica da Falha

Em `apps/worker/src/index.ts`, uma única conexão TCP ioredis (`const connection = createRedisConnection(...)`) é instanciada e compartilhada indistintamente entre:
- 4 instâncias de Queue: `chatQueue`, `agentRunQueue`, `skillQueue`, `routineQueue`
- 4 instâncias de Worker: `chatWorker`, `agentWorker`, `skillWorker`, `routineWorker`

Conforme a documentação oficial do BullMQ:
> *"Workers use blocking commands such as `BRPOPLPUSH` or `BLMOVE` to wait for incoming jobs. You must NEVER share a Redis client instance between multiple workers, nor between workers and queues. Doing so will block other commands, causing timeouts, stalled jobs, and connection drops."*

Quando qualquer um dos workers entra em estado de bloqueio esperando um novo job no Redis, a conexão compartilhada fica ocupada e não consegue responder a comandos normais de escrita (`queue.add`), consulta de status ou renovação de lease (`job.extendLock`).

Isso explica potenciais erros esporádicos de:
- `Connection is closed`
- `Command timed out`
- Jobs marcados falsamente como `stalled` pelo BullMQ.

---

## 3. Impacto de Negócio e Segurança

- Atrasos imprevisíveis na execução de rotinas e mensagens de chat.
- Desperdício de computação por jobs reexecutados indevidamente (stalled jobs).
- Instabilidade do cluster de background jobs.

---

## 4. Bibliotecas Externas Recomendadas

- Padrão recomendado pela biblioteca **`bullmq`**: passar o objeto de configuração de conexão (`ConnectionOptions`: `{ host, port, maxRetriesPerRequest: null }`) diretamente em vez de um cliente ioredis instanciado.

---

## 5. Passos para Validação pelo QA

1. Subir o worker e disparar concorrência moderada (10 jobs simultâneos distribuídos entre as 4 filas).
2. Monitorar os logs do worker procurando por avisos do BullMQ:
   `[WARN] Possible Redis connection blocking detected`.
3. Inspecionar o tempo de resposta entre o enfileiramento na API e o início do processamento no Worker.

---

## 6. Plano de Ação e Remediação

1. Refatorar o pacote `@workspace/queue`:
   - Em vez de receber `connection: Redis`, permitir que as funções `createWorker` e `createQueue` recebam ou a URL (`redisUrl`) ou opções de conexão (`ConnectionOptions`).
   - Se for necessário passar instâncias manuais, chamar `connection.duplicate()` para cada Worker e para cada Queue.
2. Garantir que cada Worker possua suas próprias conexões isoladas (uma para comandos normais e outra dedicada aos comandos bloqueantes `bpop`).
