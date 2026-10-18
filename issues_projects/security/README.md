# Central de Segurança, Arquitetura e Tipagem — Atlas Agent

Este diretório contém o levantamento completo das vulnerabilidades, inconformidades de tipagem e falhas arquiteturais identificadas na auditoria do backend (`apps/api`, `apps/worker`, `packages/*`).

As issues estão distribuídas em pastas de **1 a 10 por nível de agravante**, onde **1 é leve** e **10 é crítico/severo**.

---

## Índice por Agravante

### [Pasta 10/](./10/) — Agravante Crítico Máximo
- [`01-SEC-01-sandbox-arbitrary-control-docker-socket.md`](./10/01-SEC-01-sandbox-arbitrary-control-docker-socket.md): Controle arbitrário do Sandbox e exposição do Docker Socket (RCE/SSRF/Host Escape).
- [`02-SEC-02-missing-api-authentication.md`](./10/02-SEC-02-missing-api-authentication.md): Ausência total de autenticação e autorização em todos os endpoints da API.

### [Pasta 9/](./9/) — Agravante Crítico / Alto
- [`01-ARQ-01-sse-stream-aggressive-db-polling.md`](./9/01-ARQ-01-sse-stream-aggressive-db-polling.md): Polling agressivo no PostgreSQL via SSE (loop de 80ms esgotando conexões do banco).
- [`02-SEC-03-missing-rate-limiting-payload-dos.md`](./9/02-SEC-03-missing-rate-limiting-payload-dos.md): Ausência de Rate Limiting e de limites de payload (ataque de DoS e custo ilimitado com LLM).

### [Pasta 8/](./8/) — Agravante Alto
- [`01-ARQ-02-in-memory-sandbox-session-split-brain.md`](./8/01-ARQ-02-in-memory-sandbox-session-split-brain.md): Armazenamento de sessões em Map in-memory entre múltiplos processos (Split-Brain e Reaper matando containers ativos).
- [`02-ARQ-03-shared-redis-connection-bullmq-block.md`](./8/02-ARQ-03-shared-redis-connection-bullmq-block.md): Conexão Redis única compartilhada entre 4 Workers e Filas BullMQ (Bloqueio de comandos I/O e latência).

### [Pasta 7/](./7/) — Agravante Médio-Alto
- [`01-SEC-04-hardcoded-pepper-timing-safe-webhook.md`](./7/01-SEC-04-hardcoded-pepper-timing-safe-webhook.md): Pepper de Webhooks com fallback público hardcoded e verificação suscetível a timing attack.
- [`02-SEC-05-naive-regex-prompt-injection-memory.md`](./7/02-SEC-05-naive-regex-prompt-injection-memory.md): Blacklist Regex ingênua para sanitização de prompt injection na memória persistente.

### [Pasta 6/](./6/) — Agravante Médio
- [`01-TIP-01-missing-runtime-schema-validation-zod.md`](./6/01-TIP-01-missing-runtime-schema-validation-zod.md): Ausência de validação de schemas em runtime com Zod (parsers manuais frágeis e incompletos).
- [`02-SEC-06-missing-security-headers-cors.md`](./6/02-SEC-06-missing-security-headers-cors.md): Ausência de cabeçalhos de segurança HTTP (CSP, HSTS) e configuração de CORS frouxa.

### [Pasta 5/](./5/) — Agravante Moderado
- [`01-ARQ-04-missing-multi-tenancy-isolation.md`](./5/01-ARQ-04-missing-multi-tenancy-isolation.md): Falta de isolamento Multi-Tenancy nativo (`DEFAULT_USER_ID = "default"` compartilhado).

### [Pasta 4/](./4/) — Agravante Baixo-Médio
- [`01-TIP-02-weak-pgvector-json-prisma-typing.md`](./4/01-TIP-02-weak-pgvector-json-prisma-typing.md): Tipagem fraca de campos JSON e vetoriais (`pgvector`) no Prisma com casts inseguros.

### [Pasta 3/](./3/) — Agravante Baixo
- [`01-ARQ-05-sandbox-container-concurrency-limits.md`](./3/01-ARQ-05-sandbox-container-concurrency-limits.md): Ausência de teto global para contêineres Docker simultâneos.

### [Pasta 2/](./2/) — Agravante Mínimo / Operacional
- [`01-ARQ-06-unstructured-logging-missing-correlation.md`](./2/01-ARQ-06-unstructured-logging-missing-correlation.md): Logs não estruturados via `console.*` sem identificadores de correlação (Correlation IDs).

### [Pasta 1/](./1/) — Agravante Trivial / Estilo
- [`01-TIP-03-shared-contracts-null-undefined-drift.md`](./1/01-TIP-03-shared-contracts-null-undefined-drift.md): Inconsistência de contratos nos DTOs compartilhados (`null` vs `undefined`).
