# Issues — Boot / readiness do container

- [ ] [P1] **ABERTO** — `parsePublishedPort` sem retry (`packages/sandbox/src/docker-manager.ts`, `createSession` ~234-247 e `ensureRunning` ~428-436). Um único `inspect()` logo após `start()`; se o Docker Desktop atrasar o bind, cai em `Failed to resolve published sandbox ports` (503 `sandbox_infra`). É o próximo flake mais provável. Sugestão: re-`inspect` 5×500ms.
- [ ] [P1] **ABERTO** — `container.start()` sem timeout (`docker-manager.ts:234, 425`). Daemon travado = espera indefinida. Sugestão: timeout no `start`.
- [ ] [P2] **ABERTO** — Sem auto-pull de imagem (`packages/sandbox/src/config.ts`, `createContainer` em `docker-manager.ts:196-227`). Máquina nova / imagem removida = `No such image` para sempre; retry do front inútil. Sugestão: pull-on-404 ou documentar o `docker build`.
- [ ] [P3] **ABERTO** — Classificação de erro por substring é frágil (`apps/api/src/routes/sandbox.ts:132-137`; ex. driver que diga `image not known` cai em `sandbox_unavailable`). Tem fallback, só perde precisão.

## Já corrigido (referência)

- [x] **FECHADO** — Control server sobe early no entrypoint (readiness em ~2-3s).
- [x] **FECHADO** — CDP timeout virou warning (não mata o boot).
- [x] **FECHADO** — `SANDBOX_READY_ATTEMPTS` / `SANDBOX_READY_DELAY_MS` configuráveis.
- [x] **FECHADO** — `code` no 503 do backend (`sandbox_start_timeout`/`sandbox_infra`/`sandbox_unavailable`).
- [x] **FECHADO** — Barra do noVNC + diálogo Conectar escondidos via CSS no entrypoint.
