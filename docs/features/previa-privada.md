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
| Cookies do app | não funcionam (todo `Set-Cookie` do projeto é descartado e nenhum cookie vai ao projeto; a prévia nem usa cookie) | funcionam (sem `Domain`) |
| `localStorage`/`sessionStorage`/IndexedDB | lançam `SecurityError` | funcionam |
| Login dentro do projeto | não funciona | funciona |
| Recarga ao vivo (HMR, WebSocket) | **desligada**: recarregue a página | funciona |
| Caminhos absolutos (`/assets/x.js`) | só com o servidor configurado com a base (`vite --base /v1/previews/<id>/p/<cap>/`, que a tool informa) ou caminhos relativos | funciona |
| Módulos, fontes e `fetch` | funcionam (CORS `*`, sem credenciais; `credentials: 'include'` não) | funcionam |
| `Origin` que o projeto vê | `null` (e `Origin` é removido ao repassar) | o do domínio da prévia |
| Custo para o operador | nenhum | domínio, DNS curinga, certificado, rota |

O modo é escolhido na subida: sem `ATLAS_PREVIEW_BASE_DOMAIN`, ou com valor inválido ou no mesmo site do Atlas (a API loga o motivo e cai no básico), vale o básico. Com domínio válido, o completo, exatamente como antes. O bot manda o mesmo link `/open` nos dois e só fica sabendo do modo pelo resultado de `preview_start`.

## Modo básico: como funciona e por que é seguro
1. **Segredo no caminho, sem cookie.** `preview_start` gera um `cap` aleatório (24 bytes, 32 caracteres) e o grava em `dev_sessions.preview.cap`; ele é mantido enquanto a prévia vale (para o `--base` já configurado no servidor continuar certo) e some com `preview_stop` ou o vencimento. `GET /v1/previews/<id>/open` (`requireUser` + dono; 404 para qualquer outro caso, e também para prévia sem `cap`) redireciona para `/v1/previews/<id>/p/<cap>/<entrada>`. URLs relativas mantêm o `cap` sozinhas.
2. **Por que não cookie** (primeira versão, descartada): do documento em sandbox o Atlas é cross-origin, então `<script type="module">`, `crossorigin`, `modulepreload`, fontes e `fetch()` saem como CORS anônimo, sem cookie, e levavam 401 (builds do Vite quebravam). O `cap` no caminho vale para qualquer tipo de requisição. De quebra some o risco de CSRF por id: quem não conhece o `cap` não alcança a prévia.
3. `/v1/previews/<id>/p/*` é público no `requireUser` (allowlist `isPublicV1Request`, regex estrita com o id) porque a autenticação é o `cap`, conferido em tempo constante no proxy; o cookie de login do Atlas nunca é exigido. Qualquer falha (id, `cap`, vencida, parada) responde igual: 401 "Link expirado". Tem limite por IP (1200/min; ver "Riscos"). O destino do proxy continua vindo só do banco (SSRF).
4. **Toda** resposta de `/p/` (HTML, JS, JSON, binário, redirect, HEAD/206/304, erro do projeto e as recusas 401/404/429/413/500/502) leva `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads` (sem `allow-same-origin` e sem `allow-top-navigation`), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: cross-origin` (os subrecursos vêm da origem opaca), `X-Frame-Options: SAMEORIGIN`, `Cache-Control: private, no-store` (o `public`/`s-maxage` do projeto não vale), `nosniff`, `no-referrer` e `noindex`. Um middleware (`basicResponseHeaders`) envolve o limite de IP e o `onError`, então nem as respostas que não passam pelo proxy escapam.
5. **CORS:** `Access-Control-Allow-Origin: *`, sem credenciais, em toda resposta de `/p/`; o preflight (`OPTIONS`) é respondido pela API (o `cap` é exigido) e não chega ao projeto. Como o `Allow-Origin` é `*`, `credentials: 'include'` fica bloqueado de propósito.
6. **O que o projeto não controla:** do que ele devolve são descartados `Set-Cookie`, `Content-Security-Policy*`, COOP/COEP/CORP, `X-Frame-Options`, `Cache-Control`/`Expires`/`Pragma`, todo `Access-Control-*`, `Service-Worker-Allowed`, `Clear-Site-Data`, `Strict-Transport-Security` e afins, `Alt-Svc`, `Report-To`/`NEL`, Client Hints e `Link` (poderia pré-carregar hosts externos). O cabeçalho `Cookie` **nunca** segue ao projeto (nem o do Atlas).
7. **Caminho:** depois do `cap`, o resto é recusado com 404 (sem tocar o projeto) se tiver `//`, `\`, `%2f`, `%5c`, NUL/controle ou segmento `.`/`..` (também codificado). O prefixo é tirado antes de repassar, a menos que `preview_start` receba `base_configured: true` (servidor configurado com a base, ex.: `vite --base /v1/previews/<id>/p/<cap>/`, que o resultado da tool já traz completo; `dev_sessions.preview.basePrefixed`). Não há reescrita de HTML nem `<base href>` (não é barato nem seguro em streaming, e não resolve `/assets/x.js`).
8. **Redirecionamentos:** `Location`/`Refresh` para endereço interno, para a origem do Atlas ou `/caminho` entram no prefixo (com o `cap`); relativos e os que já têm o prefixo ficam. Qualquer destino fora da prévia (`//host`, `\host`, `/\host`, URL externa, `javascript:`, controle) vira **502 "Redirecionamento para fora da prévia bloqueado"** (a origem do Atlas não serve de redirecionamento aberto); `Refresh` e `Content-Location` externos são descartados.
9. **WebSocket/HMR: desligado** (a API responde 403 no upgrade). O handshake não passa por CORS e a origem seria `"null"`, igual à de qualquer página em sandbox de qualquer site; recusar é o lado seguro. O bot avisa para recarregar a página.
10. **Logs:** o `cap` é credencial. O log de erro e a telemetria da API usam o caminho com `/p/:cap/`. O log de acesso do proxy reverso (Traefik) é do operador: se estiver ligado, ele registra a URL completa; mantenha-o restrito ou mascare `/v1/previews/*/p/*`. O link vive no máximo 1 h.

Prova no Chromium (`apps/api/e2e/previa-basica.playwright.ts`, página no estilo Vite): `self.origin === "null"`; `document.cookie` e `localStorage` lançam `SecurityError`; `<script type="module" crossorigin>`, `modulepreload`, stylesheet e fonte `crossorigin` e `fetch('./data.json')` carregam (200) e a resposta é legível; `fetch` ao mesmo host chega ao Atlas **sem** o cookie de login e a resposta de `/v1/me` não é legível (nem com `credentials: 'include'`); o `Set-Cookie` do projeto não chega ao navegador.

CSRF e abuso: não há cookie da prévia, então nada é enviado automaticamente por um site de terceiro; o acesso exige conhecer o `cap`. Quem o tem (o dono, via link; o modelo, que o recebe no resultado da tool para configurar `--base`) alcança só o servidor de desenvolvimento daquele projeto, por no máximo 1 h. O `cap` não vaza por `Referer` (`no-referrer`), mas fica no histórico do navegador e em log de acesso do proxy (ver acima).

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
- **Limite por IP no básico:** `rateLimitByIp` usa o endereço do par (não confia em `X-Forwarded-For`, igual ao resto da API). Atrás do Traefik todos os usuários dividem um balde de 1200 req/min em `/p/`; basta para uma prévia por vez, e não abre brecha de falsificação. Se várias instâncias/usuários simultâneos virarem comum, tratar como melhoria global (IP real do proxy confiável), não só aqui.
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
- `apps/api/src/routes/previews.basic.test.ts` (modo básico: cabeçalhos em todo tipo de resposta, inclusive 502/429/500/HEAD/206/304, CORS e preflight, `cap` no caminho, nenhum cookie ao projeto, cabeçalhos perigosos descartados, caminhos inseguros, dono, vencida/parada, reescrita e bloqueio de `Location`, allowlist, WebSocket recusado) e `apps/api/e2e/previa-basica.playwright.ts` (Chromium; roda à mão, ver o cabeçalho do arquivo).
- `packages/agent-runtime/src/tools/preview.test.ts` e `dev-session.test.ts` (tools), `intent-router.dev.test.ts` (roteador) e `computer-use.economy-replay.test.ts` (economia de contexto).
- Manual: `docs/deploy-dokploy.md` §7, "Verificar".
