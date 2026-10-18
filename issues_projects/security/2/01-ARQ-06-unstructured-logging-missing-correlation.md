# ARQ-06: Logs Não Estruturados via `console.*` sem Correlation IDs

- **ID:** `ARQ-06`
- **Agravante:** 2 (Mínimo / Operacional)
- **Categoria:** Arquitetura / Observabilidade / Troubleshooting
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `apps/api/src/index.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/processors/agent-run.ts`
- `packages/db/src/search.ts`
- `packages/sandbox/src/reaper.ts`

---

## 2. Descrição Técnica da Falha

Por todo o backend, o registro de eventos e falhas é realizado exclusivamente através de chamadas estáticas `console.log(...)` e `console.error(...)` com strings simples interpoladas:

```ts
console.error("Redis connection error", err);
console.log(`Atlas worker listening on queue "${CHAT_QUEUE_NAME}"`);
console.error(`[${label}] Job failed id=${job?.id ?? "unknown"} name=${job?.name}:`, err.message);
```

### Limitações identificadas:
1. **Ausência de Correlation IDs (Trace IDs):** Quando uma requisição falha na API ou gera um erro assíncrono no Worker, não há um identificador único compartilhado (`requestId` ou `runId`) anexado em todas as mensagens de log relacionadas. O time de QA/SRE é forçado a adivinhar quais linhas pertencem a qual requisição.
2. **Formato Não Estruturado (Plain Text):** As mensagens não saem em JSON estruturado, impedindo filtros e dashboards eficientes em ferramentas de APM (Datadog, Grafana Loki, New Relic, ELK).
3. **Ausência de Níveis Configuráveis de Log:** Não há suporte para filtrar logs por níveis (`debug`, `info`, `warn`, `error`) via variável de ambiente `LOG_LEVEL`.

---

## 3. Impacto de Negócio e Segurança

- Dificuldade extrema e lentidão para investigar incidentes e bugs reportados pelo QA.
- Impossibilidade de rastreabilidade de ações executadas pelos agentes.

---

## 4. Bibliotecas Externas Recomendadas

- **`pino`** (logger ultrarrápido com saída JSON estruturada nativa) e **`pino-pretty`** (para formatação colorida em ambiente de desenvolvimento).

---

## 5. Passos para Validação pelo QA

1. Inspecionar o terminal da API e do Worker ao disparar uma requisição com erro.
2. Verificar se o output é apenas texto puro sem timestamp ISO 8601 e sem metadados estruturados.

---

## 6. Plano de Ação e Remediação

1. **Instalar e Configurar o Pino:**
   - Criar pacote `@workspace/logger` ou módulo interno exportando uma instância do Pino.
2. **Injetar Correlation ID no Hono:**
   - Adicionar middleware de `requestId` no Hono e repassá-lo nos metadados do job no BullMQ.
   - Cada log do worker deve incluir automaticamente `{ runId, jobId, step }`.
