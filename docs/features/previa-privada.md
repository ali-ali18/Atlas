# Prévia privada de projetos web

- **Status:** em andamento (código pronto; falta o domínio e a rota do operador)
- **Data:** 2026-10-30
- **Issues/PRs:** #

## O que é
Quando o bot constrói um site ou app web no ambiente de código da conversa, ele manda um link que abre o projeto rodando de verdade no navegador ou no celular do dono. Só abre para quem está logado no Atlas e é dono da conversa; outra pessoa recebe "não encontrado".

## Problema
Hoje o bot serve o projeto em `127.0.0.1:8080` dentro do container, tira vários prints e diz que o endereço não abre para o usuário. O usuário não consegue rolar, clicar nem ver no celular, e cada rodada de prints gasta tokens de imagem.

## Por que existe
Ver o projeto funcionando é o jeito mais rápido de pedir ajustes. Um link no chat troca a rodada de prints por um toque, e usa o ambiente de código que já existe (sem VM nova nem memória extra).

## Alternativas descartadas
- **Prévia na mesma origem do Atlas (ex.: `/v1/previews/:id/...`)**: o JavaScript do projeto é código do usuário ou do modelo. Na origem do Atlas ele rodaria com o cookie de login do dono (mesmo `HttpOnly`, o navegador o envia às rotas `/v1`), e uma página mal feita ou maliciosa agiria na conta. Por isso não há plano B na mesma origem: sem o domínio separado a prévia fica desligada e o bot diz isso.
- **Prévia da VM com navegador (noVNC)**: pesa mais (a VM tem 2 GB e desktop), é uma tela remota em vez da página real e não serve no celular. O ambiente de código já roda o servidor.
- **Publicar sempre em link público**: é outra etapa (nível 2 do plano "Prévia e Sites"), com pergunta ao dono porque o link fica público. Aqui o link é privado.
- **Porta publicada por container no host**: não escala (portas dinâmicas no firewall), e o modo de rede compartilhada já alcança qualquer porta do container.

## Como funciona
1. O bot sobe o servidor no container (`shell` com `background:true`, ouvindo em `0.0.0.0`) e chama `preview_start {port, path?}` (`packages/agent-runtime/src/tools/preview.ts`).
2. A tool valida a porta (1024-65535, fora 3090/3128/3129: `packages/shared/src/preview.ts`), confere por TCP, a partir do worker, que o IP do container responde nela e grava a prévia na sessão (`dev_sessions.preview`: porta, caminho de entrada, início e vencimento em 1 h). Se só responde em `127.0.0.1`, devolve a dica para ligar em `0.0.0.0` (o diagnóstico roda um teste de loopback no container).
3. O link entregue é `${ATLAS_URL}/v1/previews/<id>/open` (id = id da sessão de código). Essa rota passa por `requireUser`, filtra pelo dono e responde 404 para qualquer outro caso; se tudo certo, redireciona para `https://<id>.<ATLAS_PREVIEW_BASE_DOMAIN>/__atlas_preview_auth?t=<token de 60 s>`.
4. No domínio da prévia a API (despacho por `Host` antes das rotas normais, `apps/api/src/index.ts`) valida o token, confere de novo dono e vencimento no banco e grava um cookie `atlas_preview`: `HttpOnly`, `Secure` (com ATLAS_URL https), `SameSite=Lax`, sem `Domain` (vale só para aquele host), assinado (HMAC, id da prévia + usuário + validade ≤ 1 h). Redireciona para o caminho registrado.
5. Cada requisição seguinte exige o cookie; a API resolve o destino **só pelo banco** (sessão do dono → IP do container pela provedora Docker + porta gravada) e faz proxy HTTP e WebSocket (HMR do Vite). Nada da requisição escolhe host, IP ou porta (SSRF).
6. Cada requisição renova `lastActiveAt` (no máximo a cada 30 s) para o container não parar por ociosidade (10 min) enquanto a prévia é vista. O teto é o vencimento de 1 h da prévia; para ver mais, o bot chama `preview_start` de novo.

Decisões de segurança:
- **Cabeçalhos para o projeto:** removemos `Authorization`, `Origin`, `Referer`, `Forwarded`/`X-Forwarded-*` e o nosso cookie `atlas_preview`. Cookies do próprio app (criados pelo JavaScript dele nesse host) seguem, pois dev servers e apps com estado precisam deles; eles nunca contêm credenciais do Atlas porque o domínio é outro. `Host` vai como `<ip>:<porta>` (Vite e webpack aceitam IP).
- **`Set-Cookie` do projeto:** passa, mas sem o atributo `Domain` (um cookie para o domínio-base valeria em todas as prévias) e nunca com o nome `atlas_preview`.
- Respostas levam `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` e `X-Content-Type-Options: nosniff`.
- WebSocket: mesma checagem de cookie e `Origin` igual ao `Host` (impede WebSocket de outro site usando o cookie).
- Comparação de assinatura em tempo constante; token de entrada e cookie usam chaves HMAC distintas (um não vale como o outro).

Dados: só uma coluna nula `dev_sessions.preview JSONB` (migration `20261206000000_dev_session_preview`). Aditiva e compatível nos dois sentidos: api/worker antigos ignoram a coluna; novos tratam `null` como "sem prévia". A prévia vence sozinha; não há limpeza.

Variáveis: `ATLAS_PREVIEW_BASE_DOMAIN` (api e worker). Vazia = recurso desligado (a tool responde "prévia indisponível neste servidor" e a rota `open` devolve 404). Exige `DEV_SANDBOX_CONNECT_MODE=network`. Passos de DNS curinga, certificado e Traefik: `docs/deploy-dokploy.md` §7.

Linguagem com o usuário: o bot manda só o link do Atlas, em uma linha, no idioma dele; nunca porta, `localhost` ou endereço de container (prompt do grupo `dev` e descrição das tools). Print só se o usuário pedir.

## Riscos
- **Domínio no mesmo site do Atlas**: permitiria cookie com `Domain` amplo e CSRF same-site. A API recusa domínio igual, pai ou no mesmo domínio registrável (heurística, sem lista pública de sufixos; limitação documentada); escape hatch `ATLAS_PREVIEW_ALLOW_SAME_SITE=1`.
- **WebSocket aberto:** a autenticação é no handshake; a API revalida o banco a cada 30 s e fecha na expiração (prévia ou cookie), em `preview_stop`/ambiente parado. `preview_stop` roda no worker, então o corte do socket pode levar até 30 s.
- **Token de entrada:** uso único, 30 s; o controle de reuso é em memória do processo (com várias instâncias da api, uma vez por instância dentro dos 30 s).
- **`preview_start` renova a janela de 1 h** (intencional: é como o bot estende a prévia).
- **Frameworks que checam `Origin`/`Host`** (server actions do Next, por exemplo) podem recusar a requisição proxied. Limitação conhecida; o uso principal é Vite, páginas estáticas e dev servers comuns.
- **Dois ambientes de código ao mesmo tempo (limite atual):** uma prévia aberta mantém o container acordado até 1 h. Mitigação: vencimento duro de 1 h e `preview_stop`.
- **Deploy com versões mistas:** a coluna é aditiva e opcional (ver acima); a rota nova só existe na api nova.
- **Cache de destino (5 s)** pode servir uma resposta por alguns segundos depois de `preview_stop`; o `open` e o cookie novo dependem do banco na hora.
- **Replays/evals:** o prompt do grupo `dev` ganhou uma linha; "Bom dia" continua sem nenhuma tool nem texto de código (teste na economy replay).

## Custo
Infra: nenhum serviço novo; um proxy na API (memória desprezível) e o container de código que já existia. Tokens: troca rodadas de print por um link; as 2 tools e a linha de prompt só entram com o grupo `dev` carregado.

## Como testar
- `packages/shared/src/preview.test.ts` (porta, caminho, host).
- `apps/api/src/routes/previews.test.ts`: caminho feliz, outro usuário (404), token/cookie ausente, vencido ou adulterado (401), allowlist de porta, `Host` fora do padrão cai nas rotas normais, SSRF, cabeçalhos removidos/adicionados, WebSocket.
- `packages/agent-runtime/src/tools/preview.test.ts` e `dev-session.test.ts` (tools), `intent-router.dev.test.ts` (roteador) e `computer-use.economy-replay.test.ts` (economia de contexto).
- Manual: `docs/deploy-dokploy.md` §7, "Verificar".
