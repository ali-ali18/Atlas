# ARQ-01: Polling Agressivo no PostgreSQL via SSE (Loop de 80ms)

- **ID:** `ARQ-01`
- **Agravante:** 9 (Crítico / Alto Impacto)
- **Categoria:** Arquitetura / Desempenho / Exaustão de Recursos
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `apps/api/src/routes/runs.ts` (linhas 250 a 330)
- `apps/api/src/routes/computer.ts` (linhas 100 a 140)

---

## 2. Descrição Técnica da Falha

No endpoint de streaming SSE (`GET /v1/runs/:id/stream` e `POST /v1/chat/computer`), a API entrega eventos de progresso da IA em tempo real para o frontend usando um polling agressivo contra o PostgreSQL:

```ts
// apps/api/src/routes/runs.ts
while (true) {
  const current = await getAgentRun(runId);
  const events = await listRunEventsAfter(runId, cursor, 200);
  const liveness = await getAgentRunLiveness(runId);
  await new Promise((resolve) => setTimeout(resolve, 80));
}
```

Cada cliente conectado ao stream executa **3 consultas SQL a cada 80 milissegundos** (~37 consultas por segundo por aba aberta).

### Tabela de Carga no PostgreSQL:
- **1 cliente:** ~37 queries/segundo
- **10 clientes:** ~370 queries/segundo
- **50 clientes:** ~1.850 queries/segundo

O Prisma gerencia um pool de conexões padrão de tamanho restrito (geralmente ~10 a 20 conexões). Sob concorrência mínima, esse loop satura o pool, gerando o erro fatal:
`Timed out fetching a new connection from the connection pool`.
Todas as outras rotas da API (incluindo rotinas e chat) travam esperando conexão liberada do PostgreSQL.

---

## 3. Impacto de Negócio e Segurança

- Queda ou lentidão extrema de todo o banco de dados da aplicação.
- Travamento da interface do usuário com perda do stream SSE.
- Risco de DoS por simples abertura de múltiplas abas de chat no navegador.

---

## 4. Bibliotecas Externas Recomendadas

- **Redis Pub/Sub** nativo via **`ioredis`** (já presente nas dependências do projeto).

---

## 5. Passos para Validação pelo QA

1. Subir a API e o PostgreSQL.
2. Iniciar um Agent Run longo.
3. Abrir 10 conexões concorrentes no endpoint de stream via terminal ou script:
   ```bash
   for i in {1..10}; do
     curl -N http://localhost:3001/v1/runs/<run-id>/stream &
   done
   ```
4. Consultar no Postgres as queries em execução:
   ```sql
   SELECT count(*), state FROM pg_stat_activity GROUP BY state;
   ```
5. **Comportamento Inseguro Atual:** O banco de dados apresenta picos de 100% de CPU com centenas de transações simultâneas de polling a cada segundo.
6. **Comportamento Esperado:** Zero queries repetitivas em loop; eventos devem ser entregues via push orientados a eventos.

---

## 6. Plano de Ação e Remediação

1. **Adotar Pub/Sub com Redis:**
   - No Worker (`appendRunEvent` / `persistRunProgress`), publicar o evento serializado em um canal Redis:
     `redis.publish(`run:${runId}:events`, JSON.stringify(event))`
   - Na API (`GET /v1/runs/:id/stream`), registrar um listener no canal:
     ```ts
     const subscriber = redis.duplicate();
     await subscriber.subscribe(`run:${runId}:events`);
     subscriber.on('message', (channel, message) => {
       controller.enqueue(encoder.encode(`data: ${message}\n\n`));
     });
     ```
2. **Replay Histórico Único:**
   - Na conexão inicial do cliente, fazer **uma única** leitura no Postgres (`listRunEventsAfter(runId, 0)`) para recuperar o que já ocorreu, e em seguida chavear exclusivamente para o canal Redis Pub/Sub.
