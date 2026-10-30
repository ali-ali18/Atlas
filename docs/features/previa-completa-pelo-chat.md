# Prévia completa configurada pelo bot (fase 1)

- **Status:** em andamento (código pronto; falta conferir em servidor real)
- **Data:** 2026-10-30
- **Issues/PRs:** #8

## O que é
O administrador do servidor diz "quero a prévia completa" no chat e o bot conduz, um passo por vez, a configuração do domínio das prévias: endereço curinga no DNS, certificado de segurança (HTTPS), rota até o Atlas, variável do servidor, reinício e um teste final. Termina com "Prévia completa ligada".

## Problema
A prévia privada (`docs/features/previa-privada.md`) só funciona depois de passos manuais no DNS e no Dokploy (`docs/deploy-dokploy.md` §7). Quem não é da área trava ali.

## Por que existe
Agent-first: o usuário configura conversando. O que o Atlas consegue escrever com segurança ele escreve (DNS); o resto vira instrução exata, passo a passo, com verificação real de cada etapa.

## Alternativas descartadas
- **Atlas escrevendo tudo (Dokploy, certificado, variável):** a API do Dokploy não pôde ser conferida (docs fora do alcance da sessão e as fontes se contradizem: `/api/domain.create` com `x-api-key` ou tRPC). Sem confirmar, não se adivinha endpoint: vira instrução manual. Também evita guardar a chave do Dokploy.
- **Admin por papel novo no banco:** decisão do dono: admin = usuário com o e-mail de `ATLAS_OWNER_EMAIL` (já existe).
- **Rota própria para coletar o token:** o token do DNS vai pelo cartão seguro do cofre que já existe (`secret_request`, nome `preview-dns-token`), no cofre do próprio usuário. A restrição ao administrador está onde o segredo é usado (executor), não onde ele é guardado.
- **Fora da fase 1:** Coolify, DigitalOcean, Vercel, Hetzner, Porkbun, DuckDNS, Caddy on-demand, Route 53, k8s, TLS terminado pelo Atlas.

## Como funciona
Tool `preview_setup` (grupo lazy `preview_setup`, `packages/agent-runtime/src/tools/preview-setup/`): `status`, `configure`, `run` (avança UM passo), `rollback`.

| Passo | Quem faz | Verificação |
|---|---|---|
| DNS `*.<domínio>` → IP | Atlas (Cloudflare ou deSEC, com aprovação no cartão) ou usuário (`manual`) | resolvedor próprio (1.1.1.1/8.8.8.8, sem cache do sistema) |
| Certificado | usuário (curinga por DNS-01 no proxy, ou certificado de origem da Cloudflare) | handshake: validade, emissor, SAN `*.<domínio>`, confiável |
| Rota até a API | usuário (Dokploy: domínio `*.<domínio>` no serviço `api`, porta 3001, ou labels Traefik; ou Caddyfile) | sonda HTTPS: o 404 do proxy = rota faltando |
| Variável `ATLAS_PREVIEW_BASE_DOMAIN` e reinício | usuário (aval dele; o teste final é a prova) | teste final + o worker enxerga a variável |
| Teste final | Atlas | `GET https://atlasprobe…<domínio>/__atlas_preview_auth` → 401 "Link expirado" vindo da API |

- **Estado:** tabela `preview_setups` (um registro por dono, sem segredo). Cada chamada grava antes de responder, então o setup retoma depois do reinício ("status"). O reinício derruba a conversa; a retomada é na próxima fala do admin (não há follow-up automático: ficou fora para não criar rotina escondida).
- **Idempotência:** registro curinga igual já existente não escreve nem pede aprovação; com outro IP o setup para sem sobrescrever.
- **Aprovação:** escrita de DNS e rollback pedem cartão (nova ação pendente `infra-setup` em `apps/api/src/chat/confirmed-action.ts`). O executor só escreve ao achar a chave da chamada aprovada (`findExecutedConfirmCall`, mesmo padrão do PR).
- **Rollback:** só o registro criado pelo setup, por id (guardado no estado). O que o usuário fez à mão nunca é apagado.
- **Domínio:** `validateSetupDomain` (shared) recusa mesmo site do Atlas; a heurística agora conhece sufixos privados (dedyn.io, duckdns.org...), então o grátis passa mesmo com o Atlas no mesmo provedor.
- **APIs de terceiros:** Cloudflare (`GET /zones?name=`, `GET/POST/DELETE /zones/{id}/dns_records`, token com Zone:Zone:Read + Zone:DNS:Edit; conferido na especificação OpenAPI oficial). deSEC (`GET /domains/?owns_qname=`, `GET/POST /domains/{zone}/rrsets/`, `DELETE .../rrsets/{subname}/A/`, `Authorization: Token`; conferido por documentação e clientes conhecidos; o uso de `*` em `subname` é documentado). Hosts fixos, timeout de 15 s, resposta limitada a 256 KB, erros sem token.

## Riscos
- **Dokploy não automatizado:** passos de rota/variável/reinício dependem do usuário; a verificação final cobre o resultado. Automatizar fica para quando a API for confirmada.
- **Cloudflare com proxy + certificado de origem:** o certificado de borda gratuito cobre só `*.<zona>`; por isso `origin-cert` exige o domínio ser a própria zona (senão o setup recusa e sugere DNS-01 sem proxy).
- **Nomes de variáveis do ACME** (`CF_DNS_API_TOKEN`, `DESEC_TOKEN`) seguem o lego; o texto manda conferir no painel.
- **Aval do usuário em variável/reinício:** o modelo poderia marcar "feito" sem o usuário; o teste final reabre os passos se a API ou o worker não enxergarem o domínio.
- **Sonda:** depende do texto 401 "Link expirado" da API de prévias; mudar a mensagem em `previews.ts` quebra a sonda (teste cobre o lado do setup).
- **Deploy com versões mistas:** tabela nova independente; api/worker antigos a ignoram. A ação `infra-setup` só existe na api nova (cartão antigo cai no "Não entendi o que confirmar").
- **Custo de contexto:** a tool e o procedimento só entram com o pedido (replay "Bom dia" segue pequeno) e só para o administrador.

## Custo
Nenhum serviço novo. Tokens: ~1 tool e 4 linhas de prompt só quando o admin pede; cada passo é uma chamada curta.

## Como testar
- `packages/shared/src/preview-setup.test.ts`, `packages/db/src/preview-setup.test.ts` (outro usuário não lê nem apaga; admin por e-mail).
- `packages/agent-runtime/src/tools/preview-setup/preview-setup.test.ts` (adaptadores com fetch simulado: criar, existe, 401, 429, rede sem vazar token; passos, falha, retomada, rollback, não-admin).
- `packages/agent-runtime/src/computer-use.preview-setup.test.ts` (replay "quero a prévia completa" até "Prévia completa ligada"; "Bom dia" pequeno; não-admin sem a tool) e `context/intent-router.preview-setup.test.ts`.
- `apps/api/src/chat/confirmed-action.infra-setup.test.ts` (aprovar, recusar, outro usuário).
- Manual: num servidor real, "quero a prévia completa" como `ATLAS_OWNER_EMAIL`.
