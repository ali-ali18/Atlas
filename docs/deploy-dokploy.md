# Deploy no Dokploy com imagens prontas (GHCR)

O servidor **não compila mais nada**. O GitHub Actions (`.github/workflows/images.yml`) constrói as
imagens e as envia ao GHCR; o Dokploy só faz `pull` e sobe. Motivo e riscos: `docs/features/deploy-por-imagem.md`.

Imagens (todas `linux/amd64`, privadas porque o repositório é privado):

| Imagem | Quando é reconstruída |
|---|---|
| `ghcr.io/ali-ali18/atlas-web`, `-api`, `-worker`, `-migrate` | a cada push na `main` com o CI verde |
| `ghcr.io/ali-ali18/atlas-agent-sandbox`, `-code-runner`, `-dev-sandbox` | só quando `docker/<nome>/**` muda (ou no disparo manual) |

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

### 1.3 Registry no Dokploy

1. Painel do Dokploy → **Settings → Registry → Add Registry**.
2. Registry Name: `ghcr`. Username: `ali-ali18`. Password: o token do passo 1.2. Registry URL: `ghcr.io`.
3. Salve (use **Test Registry**, se existir). Se o Dokploy não tiver essa tela na sua versão, rode **uma vez**
   no servidor, por SSH: `docker login ghcr.io -u ali-ali18` e cole o token no prompt (nada de passar o token na linha de comando).

**(confirmar)** Num compose, o Dokploy nem sempre usa o registry cadastrado para `docker compose pull`; quem faz o
pull é o Docker do servidor, que usa as credenciais do `docker login`. Se o deploy falhar com `unauthorized`,
faça o `docker login` por SSH como acima: ele fica gravado no servidor.

### 1.4 Gerar as primeiras imagens

1. GitHub → **Actions → Imagens → Run workflow** (branch `main`, deixe "sandboxes" marcado).
2. Espere ficar verde (a primeira vez é a mais demorada, 20 a 40 min, por causa do cache vazio).
3. Em **Packages** do repositório/perfil confira as 7 imagens. Cada uma deve estar vinculada ao repositório
   (o GHCR faz isso sozinho pelo `GITHUB_TOKEN`).

### 1.5 Apontar o Dokploy para o compose novo

1. Projeto/serviço Compose do Atlas → aba **General**.
2. Origem: o repositório e a branch `main`. **Compose Path**: `./docker-compose.yml` (o override de dev **não** é lido, e é isso que queremos).
3. Aba **Environment**: mantenha as variáveis atuais e adicione:

   ```env
   ATLAS_IMAGE_TAG=latest
   ```

   (`ATLAS_SANDBOX_TAG` só se precisar fixar sandboxes; o padrão é `latest`.)
4. **Desligue o build no servidor**: nada a fazer além do que o compose já faz; ele agora não tem `build:`. Confirme
   que não há "Build"/"Pre-deploy command" customizado, e não use "Rebuild" (ele tentaria construir e não existe `build:`).
5. **Desligue o Auto Deploy por git**: na aba **Deployments** (ou **General**) do compose, desative **Auto Deploy**
   **(confirmar o nome exato do toggle)**. Motivo: hoje todo push na `main` dispara deploy no Dokploy. Com imagens
   prontas isso subiria o `latest` **antigo** (as imagens novas ainda não existem) ou correria com o build. Quem
   dispara o deploy agora é o workflow, depois que todas as imagens foram enviadas (passo 2).
6. Clique **Deploy**. Primeiro deploy: o Docker baixa as 7 imagens (alguns GB), pode levar alguns minutos.

## 2. Deploy automático pelo workflow

O último job do `images.yml` chama o webhook do Dokploy **só se** o secret `DOKPLOY_DEPLOY_WEBHOOK` existir (sem ele, é pulado).

1. No Dokploy, no compose do Atlas → aba **Deployments** → copie a **Webhook URL** (algo como `https://<painel>/api/deploy/compose/<token>`) **(confirmar o caminho)**.
2. GitHub → **Settings → Secrets and variables → Actions → aba Secrets → New repository secret**: nome `DOKPLOY_DEPLOY_WEBHOOK`, valor a URL. É um segredo: não cole em chat nem no repositório.
3. Fluxo final: push na `main` → CI verde → imagens no GHCR → webhook → Dokploy faz `pull` e recria os serviços.

Incerteza importante **(confirmar)**: o webhook de compose do Dokploy foi feito para eventos do GitHub; o workflow envia um
corpo `{"ref":"refs/heads/main"}` com `X-GitHub-Event: push`. Se o Dokploy ignorar o webhook enquanto o **Auto Deploy**
estiver desligado, as opções são (a) deixar Auto Deploy ligado **só** para o webhook funcionar, desde que o repositório
não esteja conectado a um webhook do GitHub (remova o webhook automático do Dokploy em GitHub → Settings → Webhooks, para
o push da `main` não disparar sozinho), ou (b) clicar **Deploy** manualmente depois do workflow verde.

Sem webhook, o fluxo manual: esperar o workflow **Imagens** ficar verde e clicar **Deploy** no Dokploy.

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
# todo dia às 04:00: remove imagens sem uso há mais de 7 dias (as em uso e as recentes ficam, dá para fazer rollback)
0 4 * * * docker image prune -a -f --filter "until=168h"
```

Cuidado: `docker image prune -a` apaga imagens **sem container**, incluindo as de sandbox que ficam sem uso por
dias (serão puxadas de novo no próximo deploy, porque os serviços `agent-sandbox`/`dev-sandbox` as puxam). O filtro
`until=168h` considera a data de criação da imagem, e imagens de sandbox raramente mudam: por isso elas também podem ser
removidas, e o próximo deploy as baixa de novo. Se uma sessão pedir sandbox antes disso, a criação falha por falta da imagem: rode **Deploy** de novo.
Uma alternativa mais conservadora é só `docker image prune -f` (apenas imagens sem tag).

## 5. Memória (VPS de 8 GB, ~5 GB para o Atlas)

Limites em `docker-compose.yml` (`mem_limit`); um vazamento reinicia só o container (`restart: unless-stopped`), não o servidor:

| Serviço | Limite | Heap do Node |
|---|---|---|
| postgres | 1g | n/a |
| redis | 256m | n/a |
| searxng | 256m | n/a |
| docker-socket-proxy | 64m | n/a |
| api | 768m | 576 MB |
| worker | 1g (inclui o Chromium) | 640 MB |
| web | 512m | 384 MB |
| migrate (curto) | 512m | 384 MB |
| sandboxes (só puxam imagem) | 64m | n/a |

Soma dos permanentes: ~3,4 GB; com o `migrate` rodando, ~3,9 GB. O restante é para as **sandboxes criadas pelo app**
(`SANDBOX_MEMORY_MB`, padrão 2048 por VM; `DEV_SANDBOX_MEMORY_BUDGET_MB`, padrão 4096; `CODE_RUNNER_MEMORY_MB`, padrão 512).
O gerenciador (`packages/sandbox`) já aplica esses limites na criação de cada container, então o limite mora lá e não
no compose. Em 5 GB, considere `SANDBOX_MEMORY_MB=1024` e `DEV_SANDBOX_MEMORY_BUDGET_MB=1536`, ou deixe `DEV_SANDBOX_ENABLED=false`.

## 6. Checklist de nomes (só nomes, sem valores aqui)

- GitHub, Variables: `SENTRY_DSN` (opcional), `ATLAS_API_INTERNAL_URL` (opcional).
- GitHub, Secrets: `DOKPLOY_DEPLOY_WEBHOOK` (opcional; sem ele o deploy é manual).
- Dokploy, Registry: usuário `ali-ali18` + token `read:packages` (só no painel).
- Dokploy, Environment: `ATLAS_IMAGE_TAG` (e as variáveis que já existem).
