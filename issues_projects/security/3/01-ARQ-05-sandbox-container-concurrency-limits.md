# ARQ-05: Ausência de Teto Global para Contêineres Sandbox Ativos Simultâneos

- **ID:** `ARQ-05`
- **Agravante:** 3 (Baixo)
- **Categoria:** Arquitetura / Gestão de Infraestrutura / Esgotamento de Recursos
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `packages/sandbox/src/docker-manager.ts`
- `packages/sandbox/src/config.ts`
- `apps/api/src/routes/sandbox.ts`
- `apps/worker/src/processors/agent-run.ts`

---

## 2. Descrição Técnica da Falha

Cada contêiner de Sandbox instanciado roda uma sessão desktop completa (XFCE, Xvfb, noVNC e navegador Chromium em modo headless/headful), com consumo alocado de:
- **RAM:** ~2048 MB (configurável via `SANDBOX_MEMORY_MB`).
- **CPU:** 1 núcleo (configurável via `SANDBOX_CPUS`).

Atualmente, **não há nenhum controle de limite máximo global** para a criação de contêineres simultâneos no Docker do host:
1. Qualquer quantidade de chamadas para `POST /v1/sandbox/sessions` ou runs simultâneos no Worker cria novos contêineres Docker sem verificação prévia de capacidade do host.
2. Em uma máquina ou VM com 16 GB de RAM, criar 7 ou 8 contêineres simultâneos consome toda a memória do host, disparando o `OOM Killer` do Linux ou travando o Docker Desktop no Windows/macOS.

---

## 3. Impacto de Negócio e Segurança

- Queda do daemon do Docker por exaustão de memória da máquina hospedeira.
- Travamento em cascata de todos os outros serviços locais (`postgres`, `redis`, `api`).

---

## 4. Bibliotecas Externas Recomendadas

- Semáforo distribuído em Redis (ex: biblioteca **`async-mutex`** ou script Lua no **`ioredis`**).

---

## 5. Passos para Validação pelo QA

1. Subir a API.
2. Disparar a criação de 12 sessões seguidas de sandbox via API:
   ```bash
   for i in {1..12}; do
     curl -X POST http://localhost:3001/v1/sandbox/sessions \
       -H "Content-Type: application/json" \
       -d '{"autoNavigateUrl": "https://google.com"}' &
   done
   ```
3. Observar o consumo de memória RAM pelo Docker (`docker stats`).
4. **Comportamento Inseguro Atual:** O sistema tenta subir todos os 12 contêineres até congelar a máquina.
5. **Comportamento Esperado:** A partir do limite máximo (ex: 5 contêineres), a API deve rejeitar ordenadamente com `503 Service Unavailable (Sandbox capacity reached, try again later)`.

---

## 6. Plano de Ação e Remediação

1. **Configuração de Capacidade:**
   - Adicionar variável de ambiente `SANDBOX_MAX_CONCURRENT_SESSIONS=5` em `packages/sandbox/src/config.ts`.
2. **Checagem Atômica Antes do `docker.createContainer`:**
   - Antes de instanciar um novo contêiner, contar contêineres ativos com label `atlas.sandbox=true`.
   - Se a contagem atual for `>= SANDBOX_MAX_CONCURRENT_SESSIONS`, rejeitar a requisição ou enfileirar até que um contêiner anterior seja encerrado pelo Reaper.
