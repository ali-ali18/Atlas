# Prévia privada de projetos web

- **Status:** em andamento (modo básico pronto e ligado por padrão; modo completo precisa do domínio e da rota do operador)
- **Data:** 2026-10-30
- **Issues/PRs:** #

## O que é
Quando o bot constrói um site ou app web no ambiente de código da conversa, ele manda um link que abre o projeto rodando de verdade no navegador ou no celular do dono. Só abre para quem está logado no Atlas e é dono da conversa; outra pessoa recebe "não encontrado".

## Problema
Hoje o bot serve o projeto em `127.0.0.1:8080` dentro do container, tira vários prints e diz que o endereço não abre para o usuário. O usuário não consegue rolar, clicar nem ver no celular, e cada rodada de prints gasta tokens de imagem.

## Por que existe
Ver o projeto funcionando é o jeito mais rápido de pedir ajustes. Um link no chat troca a rodada de prints por um toque, e usa o ambiente de código que já existe (sem VM nova nem memória extra).

## Alternativas descartadas
- **Prévia na mesma origem do Atlas, sem isolamento**: o JavaScript do projeto é código do usuário ou do modelo. Na origem do Atlas ele rodaria com o cookie de login do dono (mesmo `HttpOnly`, o navegador o envia às rotas `/v1`), e uma página mal feita ou maliciosa agiria na conta. Por isso a mesma origem **só existe com sandbox** (modo básico, abaixo); sem o sandbox seria um furo.
- **Prévia da VM com navegador (noVNC)**: pesa mais (a VM tem 2 GB e desktop), é uma tela remota em vez da página real e não serve no celular. O ambiente de código já roda o servidor.
- **Publicar sempre em link público**: é outra etapa (nível 2 do plano "Prévia e Sites"), com pergunta ao dono porque o link fica público. Aqui o link é privado.
- **Porta publicada por container no host**: não escala (portas dinâmicas no firewall), e o modo de rede compartilhada já alcança qualquer porta do container.

## Dois modos

| | **Básico** (padrão, sem configurar nada) | **Completo** (`ATLAS_PREVIEW_BASE_DOMAIN` válido e separado) |
|---|---|---|
| Endereço | `${ATLAS_URL}/v1/previews/<id>/p/...` | `https://<id>.<domínio-base>/...` |
| Isolamento | CSP `sandbox` sem `allow-same-origin`: o documento roda em **origem opaca** | origem separada do navegador |
| Cookies do app | não funcionam (todo `Set-Cookie` do projeto é descartado e nenhum cookie vai ao projeto) | funcionam (sem `Domain`) |
| `localStorage`/`sessionStorage`/IndexedDB | lançam `SecurityError` | funcionam |
| Login dentro do projeto | não funciona | funciona |
| Recarga ao vivo (HMR, WebSocket) | **desligada**: recarregue a página | funciona |
| Caminhos absolutos (`/assets/x.js`) | só com o servidor configurado com a base (`vite --base`) ou caminhos relativos | funciona |
| `Origin` que o projeto vê | `null` (e `Origin` é removido ao repassar) | o do domínio da prévia |
| Custo para o operador | nenhum | domínio, DNS curinga, certificado, rota |

O modo é escolhido na subida: sem `ATLAS_PREVIEW_BASE_DOMAIN`, ou com valor inválido ou no mesmo site do Atlas (a API loga o motivo e cai no básico), vale o básico. Com domínio válido, o completo, exatamente como antes. O bot manda o mesmo link `/open` nos dois e só fica sabendo do modo pelo resultado de `preview_start`.

## Modo básico: como funciona e por que é seguro
1. `GET /v1/previews/<id>/open` (`requireUser` + dono; 404 para qualquer outro caso) assina o cookie `atlas_preview` (HMAC da sessão, id da prévia + usuário + validade ≤ 1 h) e redireciona para `/v1/previews/<id>/p/<entrada>`. Não há token intermediário: é a mesma origem e o login do Atlas já provou o dono.
2. O cookie é `HttpOnly`, `Path=/v1/previews/<id>/` (só esta prévia), sem `Domain`, `SameSite=None; Secure`. `None` é necessário porque os subrecursos (scripts, imagens, `fetch`) saem de uma origem opaca, que é cross-site. Em `http` fora de `localhost` o navegador recusaria `None`, então cai em `Lax` (a página abre, mas os subrecursos não autenticam: use https, que é o caso de produção).
3. `/v1/previews/<id>/p/*` é público no `requireUser` (allowlist `isPublicV1Request`, regex estrita com o id) porque a autenticação é o cookie da prévia, conferido no proxy; o cookie de login do Atlas nunca é exigido. Tem limite por IP (1200/min). O destino do proxy continua vindo só do banco (SSRF).
4. **Toda** resposta (HTML, JS, JSON, binário, redirect, erro do projeto e as recusas 401/404) leva `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads` (sem `allow-same-origin` e sem `allow-top-navigation`), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: cross-origin` (os subrecursos vêm da origem opaca; `same-origin` quebraria a própria página), `X-Frame-Options: SAMEORIGIN`, mais `nosniff`, `no-referrer` e `noindex`. A política de segurança do projeto é descartada para não competir com a nossa.
5. Cookies: o cabeçalho `Cookie` **nunca** segue ao projeto (nem o do Atlas nem o da prévia) e todo `Set-Cookie` dele é descartado, para que um app nunca consiga plantar cookie com `Path=/` ou `Domain` na origem do Atlas.
6. Prefixo de caminho: `Location`, `Content-Location` e `Refresh` que o projeto devolve (endereço interno ou `/caminho`) entram no prefixo; relativos e externos ficam; quem já tem o prefixo não é duplicado. O prefixo é tirado antes de repassar ao projeto, a menos que `preview_start` receba `base_configured: true` (servidor configurado com a base, ex.: `vite --base /v1/previews/<id>/p/`; fica em `dev_sessions.preview.basePrefixed`, campo opcional que versões antigas ignoram). A tool devolve ao modelo o prefixo exato e os comandos; **não** há reescrita de HTML nem `<base href>` (não é barato nem seguro de fazer em streaming, e `<base>` não resolve URLs absolutas).
7. WebSocket/HMR: **desligado** (a API responde 403 no upgrade). O handshake não passa por CORS e a origem seria `"null"`, igual à de qualquer página em sandbox de qualquer site; com cookie `SameSite=None` não há como distinguir a prévia de um site hostil. Recusar é o lado seguro; o bot avisa para recarregar a página.

Prova no Chromium (`apps/api/e2e/previa-basica.playwright.ts`): `self.origin === "null"`; `document.cookie` e `localStorage` lançam `SecurityError`; `fetch` ao mesmo host chega ao Atlas **sem** o cookie de login e a resposta não é legível (CORS); o subrecurso da página carrega com o cookie da prévia; o `Set-Cookie` do projeto não chega ao navegador; o cookie da prévia tem `Path` do id, `HttpOnly`, `SameSite=None`.

CSRF e abuso: o cookie `SameSite=None` com `Path` do id só dá acesso à prévia **daquele dono**, de leitura/proxy do servidor de desenvolvimento dele; não abre nenhuma rota do Atlas (as outras exigem o cookie de login, que a origem opaca não envia e o proxy não repassa). Uma página de terceiro que saiba o id (cuid de 25 caracteres, só está no link e na sessão) poderia fazer o navegador do dono carregar subrecursos ou enviar requisições ao servidor de desenvolvimento dele, o mesmo que ele mesmo já faz ao abrir o link. Sem o id nada disso é possível, e o id não vaza por `Referer` (`no-referrer`). Limitação: o proxy não distingue requisição da própria prévia de requisição de página de terceiro (ambas têm `Origin: null`/cross-site).

## Como funciona (modo completo)
1. O bot sobe o servidor no container (`shell` com `background:true`, ouvindo em `0.0.0.0`) e chama `preview_start {port, path?}` (`packages/agent-runtime/src/tools/preview.ts`).
2. A tool valida a porta (1024-65535, fora 3090/3128/3129: `packages/shared/src/preview.ts`), confere por TCP, a partir do worker, que o IP do container responde nela e grava a prévia na sessão (`dev_sessions.preview`: porta, caminho de entrada, início e vencimento em 1 h). Se só responde em `127.0.0.1`, devolve a dica para ligar em `0.0.0.0` (o diagnóstico roda um teste de loopback no container).
3. O link entregue (nos dois modos) é `${ATLAS_URL}/v1/previews/<id>/open` (id = id da sessão de código). Essa rota passa por `requireUser`, filtra pelo dono e responde 404 para qualquer outro caso; se tudo certo, redireciona para `https://<id>.<ATLAS_PREVIEW_BASE_DOMAIN>/__atlas_preview_auth?t=<token de 60 s>`.
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

Variáveis: `ATLAS_PREVIEW_BASE_DOMAIN` (api e worker), **opcional**. Vazia (ou inválida/no mesmo site do Atlas) = modo básico; a prévia só fica desligada sem `ATLAS_URL` ou `BETTER_AUTH_SECRET`. Exige `DEV_SANDBOX_CONNECT_MODE=network`. Passos de DNS curinga, certificado e Traefik: `docs/deploy-dokploy.md` §7.

Linguagem com o usuário: o bot manda só o link do Atlas, em uma linha, no idioma dele; nunca porta, `localhost` ou endereço de container (prompt do grupo `dev` e descrição das tools). Print só se o usuário pedir.

## Riscos
- **Domínio no mesmo site do Atlas**: permitiria cookie com `Domain` amplo e CSRF same-site. A API recusa (cai no modo básico) domínio igual, pai ou no mesmo domínio registrável (heurística, sem lista pública de sufixos; limitação documentada); escape hatch `ATLAS_PREVIEW_ALLOW_SAME_SITE=1`.
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
- `apps/api/src/routes/previews.basic.test.ts` (modo básico: cabeçalhos em todo tipo de resposta, cookie, nenhum cookie ao projeto, `Set-Cookie` descartado, dono, vencida/parada, reescrita de `Location`, allowlist, WebSocket recusado) e `apps/api/e2e/previa-basica.playwright.ts` (Chromium; roda à mão, ver o cabeçalho do arquivo).
- `packages/agent-runtime/src/tools/preview.test.ts` e `dev-session.test.ts` (tools), `intent-router.dev.test.ts` (roteador) e `computer-use.economy-replay.test.ts` (economia de contexto).
- Manual: `docs/deploy-dokploy.md` §7, "Verificar".
