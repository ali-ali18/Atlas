# Deploy no Dokploy com imagens prontas (GHCR)

O servidor **não compila mais nada**. O GitHub Actions (`.github/workflows/images.yml`) constrói as
imagens e as envia ao GHCR; o Dokploy só faz `pull` e sobe. Motivo e riscos: `docs/features/deploy-por-imagem.md`.

O `latest` só avança quando todas as imagens do run deram certo.

Imagens (todas `linux/amd64`, privadas porque o repositório é privado):

| Imagem | Quando é reconstruída |
|---|---|
| `ghcr.io/ali-ali18/atlas-web`, `-api`, `-worker`, `-migrate` | a cada push na `main` com o CI verde |
| `ghcr.io/ali-ali18/atlas-agent-sandbox`, `-code-runner`, `-dev-sandbox` | quando a imagem `:latest` não existe, ou `docker/<nome>/**` mudou desde a revisão gravada no label da imagem (ou no disparo manual) |

Tags: `sha-<7 primeiros do commit>` e `latest`.

> Os nomes de menus do Dokploy abaixo seguem a versão atual do painel; se algum estiver diferente na sua
> versão, procure o equivalente. Trechos marcados com **(confirmar)** não foram verificados num painel real.

## 1. Primeira vez (faça nesta ordem)

### 1.1 Variáveis no GitHub (build)

O `next build` grava valores `NEXT_PUBLIC_*` dentro do JavaScript do navegador, então eles precisam existir
**antes** do build. No GitHub: repositório → **Settings → Secrets and variables → Actions → aba Variables → New repository variable**.

| Variável | Para quê | Obrigatória? |
|---|---|---|
| `SENTRY_DSN` | DSN público do Sentry no navegador (`NEXT_PUBLIC_SENTRY_DSN`). Vazio = Sentry desligado no front | não |
| `ATLAS_API_INTERNAL_URL` | destino do proxy `/v1` e `/api/auth` do web. Padrão `http://api:3001` (nome do serviço no compose) | não, só se mudar o nome do serviço |

Observações:

- O destino do rewrite `/v1` é lido pelo Next **no build** (`rewrites()` entra no manifesto do build standalone),
  então não dá para trocá-lo só com variável de ambiente em runtime. Como o padrão `http://api:3001` é o
  nome do serviço no compose, normalmente não precisa de nada.
- `NEXT_PUBLIC_ATLAS_COMMIT` e `NEXT_PUBLIC_ATLAS_VERSION` o próprio build resolve; não configure.
- `NEXT_PUBLIC_OPENROUTER_MODEL` e `NEXT_PUBLIC_REALTIME_HUB` existem no código, mas o Dockerfile de produção
  nunca os repassou (valem os padrões). Se precisar, é preciso adicionar `ARG` no `docker/web/Dockerfile`.
- Mudou uma variável? Rode o workflow de novo (passo 4), pois só uma imagem nova leva o valor.

### 1.2 Token de leitura do GHCR

O servidor precisa de permissão para baixar imagens privadas.

1. GitHub → sua foto → **Settings → Developer settings → Personal access tokens**.
2. **Tokens (classic) → Generate new token (classic)**. Nome: `dokploy-ghcr-read`. Expiração: a que preferir (anote a data para renovar).
3. Marque **somente `read:packages`**. Gere e copie o token.
4. O token vai **só** no painel do Dokploy (próximo passo). Nunca no chat, no repositório, em `.env` commitado ou em issue.

(Alternativa: token fine-grained com permissão de leitura em Packages. Pacotes de usuário nem sempre aparecem
em fine-grained; se não funcionar, use o classic.) **(confirmar)**

### 1.3 Login no GHCR (no contexto certo)

O `docker compose pull` do deploy roda **onde o Dokploy o executa**, e isso pode ser dentro do container do Dokploy
(com o Docker do host via socket), não no seu shell SSH. Um `docker login` feito no host só vale se o Docker que faz o
pull lê as credenciais do host (`~/.docker/config.json` do usuário que roda o comando). Por isso, faça o login e **verifique no mesmo contexto do deploy**:

1. Painel do Dokploy → **Settings → Registry → Add Registry** **(confirmar o caminho)**.
   Registry Name: `ghcr`. Username: `ali-ali18`. Password: o token do passo 1.2. Registry URL: `ghcr.io`. Salve.
2. Também faça login no host, por SSH, como o mesmo usuário que o Dokploy usa (normalmente `root`), digitando o token só no prompt:
   `docker login ghcr.io -u ali-ali18` (cole o token quando pedir a senha; não o passe na linha de comando).
3. **Verificação obrigatória**, no contexto do Dokploy: abra o terminal do próprio Dokploy (aba **Terminal** do serviço, ou
   `docker exec -it <container-do-dokploy> sh` por SSH) e rode:

   ```sh
   docker pull ghcr.io/ali-ali18/atlas-api:latest
   ```

   Se baixar, o contexto está autenticado. Se der `unauthorized`/`denied`, rode o `docker login ghcr.io -u ali-ali18` **nesse mesmo
   terminal** e repita o pull. Só siga quando o pull funcionar (isso exige a imagem já publicada: faça o passo 1.4 antes de verificar).

### 1.4 Gerar as primeiras imagens

1. GitHub → **Actions → Imagens → Run workflow** (branch `main`, deixe "sandboxes" marcado).
2. Espere ficar verde (a primeira vez é a mais demorada, 20 a 40 min, por causa do cache vazio).
3. Em **Packages** do repositório/perfil confira as 7 imagens. Cada uma deve estar vinculada ao repositório
   (o GHCR faz isso sozinho pelo `GITHUB_TOKEN`).

### 1.5 Apontar o Dokploy para o compose novo

1. Projeto/serviço Compose do Atlas → aba **General**.
2. **O tipo do serviço precisa ser Compose** (Create Service → Compose, tipo **Docker Compose**), **não Stack/Swarm**. O Stack ignora
   `mem_limit` e `depends_on`: sem os limites de memória o servidor volta a cair e o `migrate` deixa de rodar antes da api.
   Se o serviço atual for Stack, crie um novo como Compose.
3. Origem: o repositório e a branch `main`. **Compose Path**: `./docker-compose.yml` (o override de dev **não** é lido, e é isso que queremos).
4. Aba **Environment**: mantenha as variáveis atuais e adicione:

   ```env
   ATLAS_IMAGE_TAG=latest
   ```

   O compose usa `pull_policy: always`, então todo Deploy baixa a imagem de novo (o Dokploy roda `up -d` sem `--pull`).

   (`ATLAS_SANDBOX_TAG` só se precisar fixar sandboxes; o padrão é `latest`.)
5. **Desligue o build no servidor**: nada a fazer além do que o compose já faz; ele agora não tem `build:`. Confirme
   que não há "Build"/"Pre-deploy command" customizado, e não use "Rebuild" (ele tentaria construir e não existe `build:`).
6. **Desligue o Auto Deploy por git**: na aba **Deployments** (ou **General**) do compose, desative **Auto Deploy**
   **(confirmar o nome exato do toggle)**. Motivo: hoje todo push na `main` dispara deploy no Dokploy. Com imagens
   prontas isso subiria o `latest` **antigo** (as imagens novas ainda não existem) ou correria com o build. Quem
   dispara o deploy agora é o workflow, depois que todas as imagens foram enviadas (passo 2).
7. Clique **Deploy**. Primeiro deploy: o Docker baixa as 7 imagens (alguns GB), pode levar alguns minutos.

## 2. Deploy automático pelo workflow

O último job do `images.yml` só roda depois que **todas** as imagens foram construídas e o `latest` foi movido. Duas formas
(a API tem prioridade; sem nenhuma, o job é pulado e o deploy é manual). Erro HTTP faz o job falhar, de propósito.

### 2a. API do Dokploy (preferida)

Secrets do GitHub (**Settings → Secrets and variables → Actions → Secrets → New repository secret**):

| Secret | O que é |
|---|---|
| `DOKPLOY_URL` | endereço do painel, ex.: `https://painel.seudominio.com` (sem `/` no fim) |
| `DOKPLOY_API_KEY` | chave de API do Dokploy |
| `DOKPLOY_COMPOSE_ID` | id do serviço Compose do Atlas |

- **API key:** no Dokploy, foto/nome do usuário → **Settings → Profile** → seção **API/CLI** → **Generate API Key** **(confirmar o caminho)**. Copie na hora (só aparece uma vez) e cole direto no secret do GitHub.
- **Compose id:** abra o serviço Compose do Atlas; o id aparece na URL do navegador (`.../project/<projectId>/services/compose/<composeId>`) **(confirmar o formato)**.
- O workflow chama `POST <DOKPLOY_URL>/api/compose.deploy` com o header `x-api-key` e corpo `{"composeId":"..."}`.
  **(confirmar)** o nome do endpoint e o formato do corpo na documentação/Swagger do seu painel (`<DOKPLOY_URL>/swagger` costuma listar a API); não pude verificar daqui.

### 2b. Webhook (alternativa)

1. No Dokploy, no compose do Atlas → aba **Deployments** → copie a **Webhook URL** **(confirmar o caminho)**.
2. Secret `DOKPLOY_DEPLOY_WEBHOOK` com essa URL (segredo: não cole em chat nem no repositório).
3. O workflow envia `{"ref":"refs/heads/main"}` com `X-GitHub-Event: push`. **(confirmar)**: o webhook de compose é pensado para eventos do GitHub e pode exigir
   o Auto Deploy ligado; se ele ignorar a chamada com Auto Deploy desligado, prefira a opção 2a.

### Fluxo e proteção contra run antigo

Push na `main` → CI verde → imagens `sha-<curto>` → `latest` movido para todas de uma vez → deploy. Se a `main` já avançou
quando o run começa, ele não publica nem faz deploy (o run mais novo cuida). Sem API nem webhook: espere o workflow **Imagens**
ficar verde e clique **Deploy** no Dokploy.

## 3. Rollback

1. Veja a tag do commit bom: no GitHub, **Packages → atlas-api → Versions** (`sha-abc1234`) ou o hash curto do commit.
2. Dokploy → compose → **Environment**: `ATLAS_IMAGE_TAG=sha-abc1234`. Salve e clique **Deploy**.
3. Para voltar ao normal: `ATLAS_IMAGE_TAG=latest` e **Deploy**.

Atenção: migrations de banco já aplicadas **não** voltam com o rollback da imagem. Se a versão ruim rodou uma
migration destrutiva, restaure o banco. Sandboxes não têm `sha` para todo commit (só quando mudam); no rollback elas ficam em `latest`.

## 4. Limpeza diária de imagens (cron no servidor)

Com `pull` a cada deploy, ficam imagens antigas no disco. Desligue a limpeza diária de cache do Dokploy
(Settings → Server → Daily Docker Cleanup), que não é mais necessária (não há cache de build no servidor), e use um cron:

```cron
# todo dia às 04:00: remove imagens sem container e criadas há mais de 7 dias
0 4 * * * docker image prune -a -f --filter "until=168h"
```

O que o comando faz: `docker image prune -a` remove toda imagem **que nenhum container usa** (parado ou rodando), e
`until=168h` limita às criadas há mais de 7 dias. Consequências:

- Imagens de app (`web`, `api`, `worker`, `migrate`) das versões anteriores somem depois de 7 dias; o rollback por `sha-...` dentro desse prazo ainda funciona, depois dele a imagem é baixada de novo do GHCR (leva alguns minutos).
- Imagens de sandbox também: elas só são **usadas** por containers criados sob demanda e os serviços `agent-sandbox`/`code-runner`/`dev-sandbox` do compose terminam logo
  (o container parado ainda conta como "em uso" enquanto existir). Se a imagem for removida, o próximo **Deploy** a puxa de novo (`pull_policy: always`). Entre a remoção e o próximo Deploy, uma sessão que precise da sandbox falha por falta da imagem.
- Opção mais conservadora, sem esse efeito: `docker image prune -f` (só imagens sem tag, as sobras dos `latest` antigos).

## 5. Memória (VPS de 8 GB, ~5 GB para o Atlas)

Limites em `docker-compose.yml` (`mem_limit`); um vazamento reinicia só o container (`restart: unless-stopped`), não o servidor.
Isso só vale com o serviço do tipo **Compose** (Stack/Swarm ignora `mem_limit`).

| Serviço | Limite | Heap do Node |
|---|---|---|
| postgres | 1g | n/a |
| redis | 256m | n/a |
| searxng | 256m | n/a |
| docker-socket-proxy | 64m | n/a |
| api | 768m | 576 MB |
| worker | 1536m (inclui o Chromium do PDF, fora do heap) | 640 MB |
| web | 512m | 384 MB |
| migrate (curto) | 512m | 384 MB |
| sandboxes (só puxam imagem) | 64m | n/a |

Soma dos tetos permanentes: 1024 + 256 + 256 + 64 + 768 + 1536 + 512 = **4416 MB (~4,3 GB)**; com o `migrate` rodando, ~4,8 GB.
São tetos, não consumo: o uso real costuma ficar bem abaixo (acompanhe com `docker stats` na primeira semana e ajuste).
As **sandboxes criadas pelo app** entram por cima: o compose agora usa `SANDBOX_MEMORY_MB=1024` (por VM),
`DEV_SANDBOX_MEMORY_BUDGET_MB=1536` (orçamento total das sessões de desenvolvimento, desligadas por padrão) e `CODE_RUNNER_MEMORY_MB=512`
(por execução). O limite de cada uma é aplicado por `packages/sandbox` na criação do container, não no compose; o próprio
gerenciador também respeita `DEV_SANDBOX_MIN_FREE_MB`. Com 1 VM + código ativos o total encosta nos 5 GB; mantenha poucas sessões simultâneas.

## 6. Volume de arquivos (`atlas-artifacts`)

Anexos, imagens e arquivos gerados ficam em disco, não no banco: a api grava em `<ATLAS_ARTIFACT_DIR>/<dono>/<id>.<ext>` e o worker lê o mesmo caminho (guardado na coluna `uri`).
Por isso **api e worker precisam montar o mesmo volume `atlas-artifacts` e usar o mesmo `ATLAS_ARTIFACT_DIR`** (no compose: `/data/artifacts`). Se um dos dois não enxerga o arquivo, o bot responde que a imagem "chegou indisponível" mesmo com a miniatura aparecendo no chat.

- Não troque o caminho nem o nome do volume em só um serviço; mudou em um, mude nos dois.
- Sem `ATLAS_ARTIFACT_DIR`, o código cai em `os.tmpdir()`: a api e o worker passam a ter pastas diferentes (e perdem tudo a cada redeploy). Em produção isso é erro de configuração.
- Na subida, api e worker logam `[artifacts] ATLAS_ARTIFACT_DIR=<caminho>`. Em produção sem a variável sai um `warn` começando com `[artifacts] ATENÇÃO`; confira os dois serviços depois de cada mudança de compose.
- Quando uma imagem anexada não carrega, o worker loga `[image-vision] imagem anexada indisponível artifact=<id> reason=<motivo> [errno=<código>]` (`not_found_for_owner`, `empty_uri` ou `read_failed` com o errno, ex.: `ENOENT`). `read_failed` + `ENOENT` quase sempre é volume não compartilhado ou deploy no meio da troca de versão. O bot tenta de novo uma vez e, se falhar, pede ao usuário que envie a imagem de novo.
## 7. Prévia privada de projetos web (opcional, passo do operador)

Com isto o bot manda um link que abre o projeto que ele está construindo no navegador/celular do dono
(`docs/features/previa-privada.md`). Sem a variável, tudo continua como antes e o bot avisa que o link não existe.
**O código não mexe na infraestrutura**: estes passos são seus.

1. **Domínio registrável separado.** Use um domínio registrado só para prévias (ex.: `atlas-previews.app`), nunca um subdomínio nem o pai do Atlas.
   Motivo: no mesmo site (mesmo domínio registrável) o código do projeto poderia plantar cookies com `Domain=` amplo que o Atlas receberia
   (cookie tossing) e fazer requisições same-site (CSRF com `SameSite=Lax`/`Strict` liberado) contra o Atlas. A API **recusa** (recurso desligado e aviso
   `[preview] prévia privada DESLIGADA` no boot) um domínio igual, pai ou no mesmo domínio registrável do `ATLAS_URL`. A checagem é uma heurística (últimos
   2 rótulos, ou 3 em sufixos como `com.br`, sem a lista pública de sufixos): num sufixo de dois níveis que ela não conhece pode errar para os dois lados.
   Escape hatch, por sua conta e risco: `ATLAS_PREVIEW_ALLOW_SAME_SITE=1`.
2. **DNS curinga.** Registro `*.<domínio-base>` (tipo A/AAAA para o IP do servidor, ou CNAME para o host do Atlas).
   Na Cloudflare, deixe **sem proxy** (nuvem cinza) se não tiver certificado curinga pago, ou use o proxy se o
   plano suportar WebSocket em subdomínio curinga.
3. **Certificado curinga.** O Let's Encrypt só emite `*.<domínio-base>` por DNS-01. No Traefik do Dokploy, configure um
   `certResolver` com DNS challenge (Cloudflare: variável `CF_DNS_API_TOKEN` com permissão Zone.DNS:Edit só nessa zona) e use-o na rota abaixo.
   **(confirmar no painel real)**
4. **Rota no Traefik/Dokploy.** No serviço `api`, adicione um domínio/regra `HostRegexp` para
   `^[a-z0-9]+\.<domínio-base com pontos escapados>$`, porta `3001`, HTTPS, **sem** prefixo de path. Exemplo de label:
   `traefik.http.routers.atlas-preview.rule=HostRegexp(`^[a-z0-9]+\.atlas-previews\.app$`)`,
   `traefik.http.routers.atlas-preview.entrypoints=websecure`, `traefik.http.routers.atlas-preview.tls.certresolver=<resolver>`,
   `traefik.http.services.atlas-preview.loadbalancer.server.port=3001`. O Traefik repassa WebSocket sozinho (HMR do Vite).
5. **Variável.** No Environment do Dokploy: `ATLAS_PREVIEW_BASE_DOMAIN=<domínio-base>` (sem `https://`, sem curinga). Vale para `api` e `worker`
   (o compose já repassa). Redeploy.
6. **Pré-requisito do ambiente de código:** `DEV_SANDBOX_CONNECT_MODE=network` (padrão do compose). Com portas publicadas só a porta de controle é
   alcançável e o bot responde que a prévia não está disponível.

Verificar: peça ao bot "cria uma página simples e me mostra". O link deve ser `${ATLAS_URL}/v1/previews/<id>/open` e, ao tocar, cair em
`https://<id>.<domínio-base>/` com a página. Outro usuário ou uma aba anônima sem passar pelo link recebe 401/404.

## 8. Checklist de nomes (só nomes, sem valores aqui)

- GitHub, Variables: `SENTRY_DSN` (opcional), `ATLAS_API_INTERNAL_URL` (opcional).
- GitHub, Secrets (opcionais; sem nenhum, o deploy é manual): `DOKPLOY_URL`, `DOKPLOY_API_KEY`, `DOKPLOY_COMPOSE_ID` (preferido) ou `DOKPLOY_DEPLOY_WEBHOOK`.
- Dokploy, Registry e `docker login` no contexto do Dokploy: usuário `ali-ali18` + token `read:packages` (só no painel/terminal).
- Serviço do tipo Compose (não Stack/Swarm).
- Dokploy, Environment: `ATLAS_IMAGE_TAG` (e as variáveis que já existem).
- Volume `atlas-artifacts` montado em api **e** worker, com o mesmo `ATLAS_ARTIFACT_DIR` (ver seção 6).
- Dokploy, Environment (opcional, prévia privada): `ATLAS_PREVIEW_BASE_DOMAIN` (ver §7); `ATLAS_PREVIEW_ALLOW_SAME_SITE` só se souber o que faz.
