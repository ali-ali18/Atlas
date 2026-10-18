# SEC-03: Ausência de Rate Limiting e Limite de Payload (DoS e Custo Excessivo)

- **ID:** `SEC-03`
- **Agravante:** 9 (Crítico / Alto Impacto)
- **Categoria:** Segurança / Resiliência / Custos
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `apps/api/src/index.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/runs.ts`
- `apps/api/src/routes/computer.ts`

---

## 2. Descrição Técnica da Falha

1. **Ausência de Rate Limiting:**
   - Não há limitador de taxa por IP, token ou usuário na API.
   - Qualquer agente externo pode disparar centenas de requisições por segundo para `/v1/chat`, `/v1/runs` ou `/v1/chat/computer`.
   - Cada requisição gera chamadas a modelos LLM no OpenRouter ou aloca instâncias de contêineres Docker, gerando exaustão rápida de recursos e custos financeiros astronômicos.

2. **Ausência de Limite no Tamanho do Body (Payload Size Limit):**
   - O framework Hono suporta middleware `bodyLimit`, mas o mesmo não está registrado em `apps/api/src/index.ts`.
   - Um payload JSON contendo um array de mensagens de dezenas de megabytes pode ser enviado diretamente para os endpoints. A serialização e o parsing de strings gigantes no event-loop do Node.js congelam a thread principal ou causam crash do processo por estouro de memória (`JavaScript heap out of memory`).

---

## 3. Impacto de Negócio e Segurança

- **Financeiro:** Cobranças elevadas na fatura da conta OpenRouter.
- **Disponibilidade:** Queda completa da API por ataque DoS de baixo custo.

---

## 4. Bibliotecas Externas Recomendadas

- **`@hono/rate-limiter`** ou **`rate-limiter-flexible`** (com backend em Redis).
- Middleware nativo **`hono/body-limit`**.

---

## 5. Passos para Validação pelo QA

1. Subir a API.
2. Disparar uma rajada de 50 requisições simultâneas contra o endpoint `/v1/chat`:
   ```bash
   for i in {1..50}; do
     curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3001/v1/chat \
       -H "Content-Type: application/json" \
       -d '{"messages": [{"role": "user", "content": "ping"}]}' &
   done
   ```
3. **Comportamento Inseguro Atual:** Todas as 50 requisições são aceitas e processadas simultaneamente.
4. **Comportamento Esperado:** A partir da taxa estipulada (ex: 20 req/min), a API deve responder com status `429 Too Many Requests` com cabeçalho `Retry-After`.

---

## 6. Plano de Ação e Remediação

1. **Configurar Rate Limiter Global e por Rota:**
   - Registrar no Hono um rate limiter usando o Redis para persistência de janelas de tempo deslizantes (sliding window).
   - Aplicar limites diferenciados:
     - Rotas gerais: 120 req/min por IP.
     - Rotas caras de IA (`/v1/runs`, `/v1/chat`): 20 req/min por usuário/IP.
2. **Definir Limite de Payload:**
   - Em `apps/api/src/index.ts`:
     ```ts
     import { bodyLimit } from 'hono/body-limit';
     app.use('*', bodyLimit({
       maxSize: 1024 * 512, // 512 KB
       onError: (c) => c.json({ error: 'Payload too large' }, 413),
     }));
     ```
