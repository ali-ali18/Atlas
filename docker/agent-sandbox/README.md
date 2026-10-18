# Agent sandbox (Docker)

Sandbox **Docker** para computer-use do Atlas: desktop virtual (Xvfb), Chromium com CDP, stream **noVNC** e API de controle (`navigate`, `screenshot`).

Não é uma VM completa — é um container com display headless e viewer web.

## Build da imagem

Na raiz do repositório (ou neste diretório):

```bash
docker build -t atlas-agent-sandbox:latest docker/agent-sandbox
```

## Verificar que o container não sai com código 127

Exit **127** costuma ser `bash`/binário ausente ou shebang inválido. A imagem instala `bash` e usa caminhos absolutos (`/usr/bin/chromium`, `/usr/bin/websockify`, etc.).

```bash
docker run --rm -p 6080:6080 -p 3080:3080 atlas-agent-sandbox:latest
# Em outro terminal:
curl -sf http://127.0.0.1:3080/health   # => ok
# Abrir http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale
```

Com a stack Atlas: `POST http://localhost:3001/v1/sandbox/sessions` deve retornar `viewerUrl` apontando para o noVNC publicado em `127.0.0.1` no host.

## O que roda dentro

| Serviço | Porta | Descrição |
|--------|-------|-----------|
| noVNC (websockify) | 6080 | Viewer: `/vnc.html?autoconnect=true` |
| Control API (Node) | 3080 | `GET /health`, `POST /navigate`, `GET /screenshot` |
| Chromium CDP | 9222 | Apenas localhost no container |

O processo `control/server.mjs` usa **Playwright** (`connectOverCDP`) no mesmo Chromium visível no VNC.

## Limites e segurança

- **Recursos**: a API/worker cria containers com `SANDBOX_MEMORY_MB` (padrão 1024) e `SANDBOX_CPUS` (padrão 1). Ajuste via env no host.
- **Rede**: padrão `bridge` (Chromium pode acessar a internet). Para isolar, `SANDBOX_NETWORK_MODE=none` (navegação externa deixa de funcionar).
- **Docker socket**: o processo que chama `createSession` (hoje `apps/api`) precisa de acesso a `/var/run/docker.sock`. Isso equivale a **root no host** se mal configurado — use apenas em dev ou com políticas restritas (usuário docker group, rootless docker, etc.).
- **Portas**: viewer e control são publicados só em `127.0.0.1` no host; exponha via túnel/reverse proxy se precisar de acesso remoto.

## Fluxo MVP

1. `POST /v1/sandbox/sessions` → `{ sessionId, viewerUrl }`
2. Abrir `viewerUrl` no browser
3. `POST /v1/sandbox/sessions/:id/navigate` com `{ "url": "https://example.com" }`
4. `GET /v1/sandbox/sessions/:id/screenshot` → PNG
5. `DELETE /v1/sandbox/sessions/:id` para parar

## Roadmap (fora deste MVP)

- `click`, `type`, `scroll` (stubs 501 no control server e em `@workspace/sandbox`)
- Uma sandbox por usuário/conversa com TTL e quotas
- Substituir Docker por microVM (Firecracker, etc.) para isolamento mais forte
- Integração com jobs BullMQ (`sandbox.navigate`) no worker

## Computer-use vs Cursor/Grok

Este slice entrega **fundação**: lifecycle Docker, viewer noVNC e duas ferramentas mínimas. Paridade total (tooling do agente no chat, gravação, políticas por tenant) virá em PRs seguintes.

## Control server: browser por referência (F12)

Endpoints novos do control server (Playwright/CDP), usados pelas tools `browser_snapshot`, `browser_act` e `browser_wait`:

| Rota | Corpo | Retorno |
|---|---|---|
| `POST /browser/snapshot` | `{ area?, scope?, offset?, limit? }` | elementos interativos visíveis com `data-atlas-ref` (`e12`), role, nome, valor, estado; máx. 80 por chamada |
| `POST /browser/act` | `{ ref, action, value?, submit?, sequential? }` | efeito (URL, valor do campo, elementos novos); `action`: click, type, select, check, uncheck, hover, press, clear |
| `POST /browser/wait` | `{ for, value?, timeoutMs?, gone? }` | `met` + tempo; `for`: text, ref, url, network, stable (máx. 20 s) |
| `GET /browser/text?offset&limit&mode` | | texto paginado (até 6000) + `scrollY/scrollHeight` |

- Depois de `navigate`/`click`/`type`/`key`/`browser_*` o servidor espera a rede acalmar e o DOM ficar 300 ms sem mutação (teto 4 s) e devolve `url`, `navigated`, `settled`.
- `type` com mais de 200 caracteres, tab ou quebra de linha cola por `xclip` + `ctrl+v` (a imagem instala `xclip`).
- Chrome pendurado ou morto é reiniciado (mesmo perfil) antes da ação falhar.
- Os testes do control server rodam com `node --test` em `docker/agent-sandbox/control`.

### Login e perfil do Chrome

O perfil (`/tmp/chrome-data`) fica num volume Docker por conversa (`atlas-profile-<conversa>`, `SANDBOX_PROFILE_VOLUMES=0` desliga), então cookies e logins sobrevivem a parar, religar e recriar a VM da mesma conversa. Não há cofre de credenciais: ao bater numa tela de login o agente pausa o run e mostra um card ("Preciso que você faça login em <site>") com "Abrir a VM" e "Terminei".

## Shell, arquivos e sessão persistente (agente)

- Usuário não-root `atlas` (home `/home/atlas`, trabalho em `/home/atlas/work`). As tools `sandbox_shell`, `sandbox_shell_wait`, `sandbox_read`, `sandbox_list` e `sandbox_download` rodam via `docker exec` **dentro** deste container, nunca no host.
- Pré-instalados para scripts em lote: `python3`, `node` + `playwright-core` (`NODE_PATH=/app/control/node_modules`, `CDP_URL=http://127.0.0.1:9222` — anexa ao Chrome logado com `chromium.connectOverCDP(process.env.CDP_URL)`), `curl`, `unzip` e `poppler-utils` (`pdftotext`).
- Volumes por conversa: `atlas-profile-<hash>` em `/tmp/chrome-data` (cookies/logins do Chrome) e `atlas-work-<hash>` em `/home/atlas/work` (downloads e scripts). Sobrevivem a stop/recriação do container; `DELETE /v1/sandbox/browser-profile?conversationId=` apaga só o perfil do Chrome.
- Rebuild obrigatório após atualizar: `docker build -t atlas-agent-sandbox:latest docker/agent-sandbox`.
