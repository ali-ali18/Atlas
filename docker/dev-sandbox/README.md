# dev-sandbox

Container leve por sessão de desenvolvimento do agente (clone, build, testes, PRs). Separado da VM com desktop (`docker/agent-sandbox`).

## Imagem

```bash
docker build -t atlas-dev-sandbox:latest docker/dev-sandbox
# ou, pelo compose (constrói e sai): docker compose build dev-sandbox
```

Node 22, git, gh, pnpm (corepack), python3, build-essential, ripgrep, curl. Usuário não-root `dev`, `/workspace` (volume por sessão) e `/cache` (volume por usuário com pnpm store, npm e pip). Servidor HTTP sem dependências em `server.mjs` (porta 3090) que exige `Authorization: Bearer $DEV_SANDBOX_TOKEN` (token gerado pelo gerenciador a cada container; só `/health` é aberto).

Rotas: `POST /exec` (background), `GET /exec/:id`, `POST /exec/:id/stdin|kill`, `GET|PUT /files`, `POST /files/patch`, `GET /files/list`, `POST /grep`.

Testes do servidor: `cd docker/dev-sandbox && node --test "test/*.test.mjs"` (os de processo usam bash e são pulados no Windows).

## Variáveis (api e worker)

| Variável | Padrão | Função |
| --- | --- | --- |
| `DEV_SANDBOX_ENABLED` | `false` | Liga as tools e o reaper |
| `DEV_SANDBOX_CALLBACK_URL` | `http://api:$PORT/v1/internal/dev-jobs/callback` (modo `network`) ou `http://host.docker.internal:$PORT/...` (`published`); `off` desliga | Para onde o container avisa que um job em segundo plano terminou (HMAC do token da sessão, sem saída). Só containers criados depois da mudança recebem; os demais dependem da varredura de segurança (5 min) |
| `DEV_SANDBOX_IMAGE` | `atlas-dev-sandbox:latest` | Imagem |
| `DEV_SANDBOX_DEFAULT_TIER` | `small` | `small` 1GB/2cpu (CPUs em `DEV_SANDBOX_SMALL_CPUS`), `medium` 2,5GB/2cpu, `large` 4GB/2cpu |
| `DEV_SANDBOX_MAX_CONCURRENT` | `2` | Teto de containers rodando |
| `DEV_SANDBOX_MEMORY_BUDGET_MB` | `4096` | Soma máxima dos limites de memória |
| `DEV_SANDBOX_MIN_FREE_MB` | `512` | Memória livre do host que deve sobrar |
| `DEV_SANDBOX_IDLE_MS` | `600000` | Ocioso por esse tempo: para o container (volume mantido) |
| `DEV_SANDBOX_EXPIRE_MS` | 7 dias | Parado por esse tempo: remove container e volume (EXPIRED) |
| `DEV_SANDBOX_PIDS_LIMIT` | `512` | Limite de processos |
| `DEV_SANDBOX_NETWORK_MODE` / `DEV_SANDBOX_CONNECT_MODE` | herdam `SANDBOX_*` | Rede e modo de conexão (`network` usa o IP interno) |

Sem vaga (concorrência, orçamento ou memória do host) a sessão fica `QUEUED` e nada é iniciado.

## Saída de internet aplicada na rede

Ambientes com rede `allowlist` ("Lista liberada") ou `off` ("Sem internet após preparar") NÃO recebem rota de internet:

```
 container da sessão ──► rede dev-egress-internal (internal: true, sem rota)
                                │
                                ▼
                  dev-egress-gateway (proxy HTTP/CONNECT)
                                │  também na rede normal (atlas-sandbox)
                                ▼
                            internet
```

- **Rede**: `dev-egress-internal` é uma rede Docker `internal: true` (no compose; o gerenciador a cria se faltar e **recusa** uma rede existente que não seja interna). Sem NET_ADMIN/iptables nos containers de sessão: quem ignora `HTTP(S)_PROXY` (`curl --noproxy '*'`, `fetch` do Node sem proxy, sockets crus) simplesmente não tem rota.
- **Gateway**: container `dev-egress-gateway` (mesma imagem, `node /app/egress-gateway.mjs`; 128 MB, sem capabilities, rootfs somente leitura, `restart: unless-stopped`, label `atlas.dev-egress`). Criado e recriado (se a imagem mudar) pelo gerenciador. Escuta o proxy em 3128 e o controle em 3129. O token de controle é gerado na criação e fica só no ambiente do gateway; api/worker o leem pelo Docker.
- **Política por sessão**: o gateway identifica a sessão pelo IP de origem na rede interna. O gerenciador registra `IP -> {mode, allowlist}` (`PUT /sessions/:ip`, bearer) ao subir/retomar o ambiente e em cada troca de política (ex.: `allowlist` na preparação, `off` depois). IP sem registro = tudo negado (inclusive após reiniciar o gateway, até o próximo registro; o gerenciador re-registra as sessões que conhece). Só portas 80/443; destinos que resolvem para IP privado/loopback/link-local (rebinding, metadata) são recusados.
- **`full`**: o container fica na rede normal, sem proxy. Mudar a política de um container em execução move-o entre as redes (`docker network connect/disconnect`).
- **DNS**: redes internas mantêm o DNS embutido do Docker, mas nomes externos podem não resolver dentro do container ("Could not resolve host"); com proxy isso não importa, o gateway resolve o nome do `CONNECT`.
- **Conexão do worker**: containers em rede interna não têm porta publicada. Por isso a aplicação na rede exige `DEV_SANDBOX_CONNECT_MODE=network` com **api e worker também na rede `dev-egress-internal`** (o compose já faz isso). Em `published` (Docker Desktop/`pnpm dev`), o gerenciador registra um aviso e usa só o proxy de melhor esforço dentro do container (como antes); `DEV_SANDBOX_EGRESS_ENFORCE=network` em `published` apenas repete o aviso.
- **Isolamento entre sessões**: containers da mesma rede interna se enxergam; cada um exige seu token (24 bytes aleatórios) para o servidor de controle, e o controle do gateway exige o token dele.

| Variável | Padrão | Função |
| --- | --- | --- |
| `DEV_SANDBOX_EGRESS_ENFORCE` | `auto` | `auto` liga com `connect=network`; `off` só proxy de melhor esforço |
| `DEV_SANDBOX_INTERNAL_NETWORK` | `dev-egress-internal` | Rede interna |
| `DEV_SANDBOX_GATEWAY_NAME` | `dev-egress-gateway` | Nome/alias DNS do gateway |
| `DEV_SANDBOX_GATEWAY_IMAGE` | `DEV_SANDBOX_IMAGE` | Imagem do gateway |
| `DEV_SANDBOX_GATEWAY_MEMORY_MB` | `128` | Limite de memória do gateway |

### Checklist Dokploy (VPS, `connectMode=network`)

1. Reconstrua a imagem `atlas-dev-sandbox` (o `docker compose build dev-sandbox` do compose já faz): ela agora traz o gateway.
2. Use o `docker-compose.yml` atualizado: ele declara a rede `dev-egress-internal` (`internal: true`) e liga **api e worker** a ela, além de `atlas-sandbox`.
3. Confirme `DEV_SANDBOX_CONNECT_MODE=network` e `DEV_SANDBOX_NETWORK_MODE=atlas-sandbox` (padrões do compose; o override de dev local NÃO é usado no Dokploy).
4. Após o deploy, crie um ambiente `allowlist` e uma sessão: `docker ps` mostra `dev-egress-gateway` (healthy); `docker network inspect dev-egress-internal` mostra `"Internal": true` com api, worker, o gateway e o container da sessão.
5. Prova: `docker exec dev-<sessão> curl --noproxy '*' -sS --max-time 8 https://example.com` deve falhar (`Could not resolve host`); `curl https://registry.npmjs.org/` (com o proxy do ambiente) deve responder.
6. Se o gateway não for alcançável, a sessão falha com erro explícito (falha fechada) apontando a rede `dev-egress-internal`.

TODO restante: containers de sessões diferentes na mesma rede interna ainda se enxergam (protegidos só pelos tokens).
