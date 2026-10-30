# Deploy por imagem pronta (GHCR) em vez de build no servidor

Status: proposta implementada em `infra/deploy-ghcr`. (Não existe `docs/features/README.md` com template na `main`; estrutura simples.)

## Por quê

A VPS tem 8 GB, ~3 GB ocupados por outro serviço, sobrando ~5 GB. Hoje o deploy do Dokploy compila tudo no servidor
(`pnpm install`, `tsc`, `prisma generate`, `next build`) com o app, Postgres, Redis e SearXNG de pé. A RAM acaba e o servidor
reinicia; o dono precisa liberar memória à mão a cada deploy. Construir fora (GitHub Actions) tira o pico do servidor: o deploy vira `pull` + recriar containers.

## Alternativas

| Opção | Prós | Contras |
|---|---|---|
| VPS maior | zero mudança | custo mensal recorrente; o pico de build continua existindo |
| Swap | barato | build lento, thrash de disco, o servidor ainda pode travar; esconde o problema |
| Construir um serviço por vez (`COMPOSE_PARALLEL_LIMIT=1`) | sem infraestrutura nova | ainda compila na VPS, deploy bem mais longo, pico do `next build` (~0,9 GB) permanece junto do app rodando |
| **Imagens no GHCR (escolhida)** | servidor sem build; rollback por tag; cache de build no registry | depende de GitHub/GHCR, de token de leitura e das variáveis de build |

## O que muda

- `.github/workflows/images.yml`: após o CI verde na `main`, constrói `web`, `api`, `worker`, `migrate` (e as sandboxes quando a pasta própria muda), envia ao GHCR com tags `sha-<curto>` e `latest`, depois move o `latest` de todas de uma vez (job `promote`) e por fim chama a API (ou o webhook) do Dokploy, se os secrets existirem.
- `docker-compose.yml`: só `image:`; `mem_limit` e `NODE_OPTIONS` por serviço; `build:` foi para `docker-compose.override.yml` (dev local igual).
- Imagens das sandboxes: o código já lia `SANDBOX_IMAGE`, `CODE_RUNNER_IMAGE`, `DEV_SANDBOX_IMAGE` (padrão `atlas-*:latest`); o compose de produção aponta para o GHCR e o override local mantém os nomes antigos.
- Guia operacional: `docs/deploy-dokploy.md`.

## Riscos e mitigação

1. **Ordem: auto-deploy por git x imagens.** Hoje o Dokploy faz deploy em todo push na `main`. Com imagens prontas ele subiria o `latest` **antigo** (a build ainda nem começou) ou correria com a publicação, e o CI ainda pode falhar. Mitigação: desligar o Auto Deploy por git do Dokploy; o deploy passa a ser disparado pelo último job do workflow, só depois de todas as imagens enviadas (e só se o CI passou). Incerteza: o webhook do Dokploy pode exigir o Auto Deploy ligado; ver `docs/deploy-dokploy.md` seção 2.
2. **Primeiro deploy.** As imagens precisam existir antes do primeiro `pull`, e as sandboxes só são construídas quando mudam. Mitigação: o workflow constrói sandbox cuja imagem `:latest` não existe; rode-o (manual) antes do primeiro Deploy. Se o `latest` de uma sandbox nunca foi publicado, `api` e `worker` não sobem (dependem dos serviços de sandbox concluídos).
3. **Variáveis `NEXT_PUBLIC_*` e rewrite `/v1`.** São embutidos no build; mudar o valor exige reconstruir o `web`. O destino do rewrite (`ATLAS_API_INTERNAL_URL`) é avaliado no build do Next standalone, então não foi tornado variável de runtime (exigiria proxy próprio ou middleware, mudança maior e arriscada). Mitigação: o padrão `http://api:3001` coincide com o nome do serviço no compose; variáveis do GitHub (`vars.*`) documentadas.
4. **Ordem do `migrate`.** Continua como serviço `migrate` com `depends_on: service_completed_successfully` para `api`/`worker`. A tag é a mesma (`ATLAS_IMAGE_TAG`), então o migrate sempre corresponde ao código. Rollback de imagem não desfaz migration.
5. **Nomes de imagem das sandboxes.** O app cria containers pelo nome da imagem via docker-socket-proxy; se o nome configurado não existir localmente, a criação falha. Mitigação: os serviços `agent-sandbox`, `code-runner`, `dev-sandbox` continuam no compose só para puxar a imagem do GHCR. A limpeza `docker image prune -a` pode remover sandboxes paradas por dias; o próximo Deploy as repõe.
6. **Registry privado.** O repositório é privado e os pacotes herdam isso: o servidor precisa de token `read:packages`. Se expirar, o deploy falha com `unauthorized`. Mitigação: anotar a validade; o token só vive no Dokploy/servidor.
7. **Memória do app em runtime.** `mem_limit` reinicia só o container, mas um limite apertado demais gera reinícios em loop (OOM kill). Os valores partem do guia do dono (tetos somados ~4,3 GB, ~4,8 GB com o migrate) e devem ser ajustados com `docker stats` na primeira semana. Sandboxes criadas pelo app já têm limite próprio em `packages/sandbox` (o compose agora usa 1024 MB por VM e orçamento de 1536 MB para sessões de desenvolvimento).
8. **Imagem `latest` mutável.** Se alguém reconstruir uma sandbox sem avisar, `latest` muda; para fixar, use `ATLAS_SANDBOX_TAG=sha-...` (só existe para commits que a reconstruíram).

## Custo

O repositório `ali-ali18/Atlas` é **público**: Actions e GHCR são gratuitos para ele, e o parágrafo abaixo vale só se voltar a ser privado (o projeto veio de `ali-ali18/agent-bot`, privado). Minutos de Actions em repositório privado entram na cota mensal do plano (Free: 2.000 min/mês em runners Linux; Pro: 3.000 min **(confirmar no plano da conta)**). Estimativa: primeiro build completo 20–40 min somando os jobs; builds seguintes de `web/api/worker/migrate` com cache de camadas em torno de 5–15 min somando os jobs; sandboxes só quando mudam. O CI atual também consome a mesma cota. GHCR: armazenamento de pacotes privados conta na cota de Packages do plano (Free: 500 MB, com excedente cobrado **(confirmar)**); 7 imagens, várias tags e cache `buildcache` podem passar disso (agent-sandbox com Chrome/VS Code é grande). Vale revisar a cota nas primeiras semanas e apagar versões antigas de pacotes se necessário. Em repositório público seria gratuito.

## Como validar

- YAML do workflow e dos composes validado com parser; `docker compose -f docker-compose.yml config` (produção) e `docker compose config` (dev) resolvem sem erro.
- Pendente (precisa de GitHub/Dokploy reais): rodar o workflow, primeiro deploy, webhook, rollback por tag.
