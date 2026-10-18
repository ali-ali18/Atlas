# F12 — Uso do computador (navegador e desktop da VM)

**Dono:** Bot B (runtime) · **Depende de:** F4 (repetição/travas), F11 (travamento com Jev; opcional), imagem do sandbox (`docker/agent-sandbox`; quem tocar o Dockerfile anota no `REVIEW.md`) · **Status:** A+B+C+D prontas para revisão

## Decisão do usuário
- **Escopo agora:** blocos A + B. C (visão/nativo) e D (verificação/travas) ficam para depois.
- **Login: sem cofre de credenciais.** Ao bater num muro de login (formulário, página "entrar", sessão expirada), o agente PARA e pede ao usuário por um **card**: "Preciso que você faça login em <site>", com botão para abrir o viewer da VM e botão "Terminei". O run pausa (mesmo caminho de pause/resume) e, no "Terminei", retoma do mesmo checkpoint e tira um novo snapshot. O perfil do Chrome persiste entre sessões da VM (volume por conversa). O modelo nunca recebe senha. No máximo um card por URL por run; se continuar deslogado, relata.
- **Modelo:** usar o modelo configurado de cada bot (sem modelo forçado).
- **Imagem do sandbox:** rebuild permitido (xclip, scripts novos do control server).

## Diagnóstico

Fonte: `agent_steps`/`agent_runs` dos últimos 10 dias (até 30/09), só leitura.

### Evidência (números)
- 335 runs no período; **50** usaram alguma tool do sandbox (navigate 201, browser_text 145, browser_links 31, scroll 30, screenshot 28, click 21, key 12, type 10, browser_click 7, browser_type 1). Tools de desktop (screenshot/click/type/key/scroll): 101 chamadas em 25 runs.
- Desfecho dos 50 runs: 22 `completed`; 2 `completed` com erro de rate-limit; 13 `failed`/`paused` por **rate-limit do modelo** (`openai/gpt-6-luna ... rate-limited upstream`, inclusive quando o run estava marcado como `anthropic/claude-sonnet-5.5`); 5 por **laço** ("Travei repetindo browser_text/screenshot/key"); 4 por tempo (30 min) ou heartbeat; 2 "Provider returned error"; 1 por limite de tool do Firecrawl.
- Falhas de tool do sandbox (~30 de ~500 chamadas): `browser_text` "Execution context was destroyed" (8), `navigate` "Chrome indisponível após tentativa de recuperação" (6) e "fetch failed" (3), `type` via xdotool com texto longo/TSV (5), `browser_click` timeout de 15 s (5), `navigate` ERR_ABORTED (3), `browser_type` em elemento que não é input (1).
- 20 chamadas consecutivas idênticas (mesma tool, mesmos args) no período.

### Runs representativos
1. **Lótus / Bling** (`cmuolg1ra…`, `cmuolnc5c…`, `cmuolqp7j…`, `cmuolzxb5…`, `cmuom2zp0…`, `cmuom4xlj…`; 30/09 21:04–21:24). O "sistema" é o **Bling** (ERP web, já logado na VM). Pedido: proposta comercial com Camomila 20 kg, Cavalinha 30 kg, Alfazema 10 kg, cliente e vendedor Alisson. Sequência típica: `screenshot → click(229,497) → screenshot → click(423,114) → screenshot`, ou `browser_text → browser_click{text:"Incluir proposta", selector:"a"}`. Em 8 tentativas o agente chegou a `orcamentos.php#add` (tela de nova proposta) mas **nunca preencheu um campo**. Causas: (a) a maioria morreu por `rate-limited upstream` após 3–5 chamadas; (b) `browser_click` com `selector:"a"`/`"button"` **ganha do `text`** (o servidor só olha `text` se não houver `selector`) e clicou no primeiro link, voltando para "Página inicial"; (c) 3 screenshots seguidos iguais → "Travei repetindo screenshot"; (d) a resposta final é honesta, mas sem progresso.
2. **Radar do mercado financeiro** (`cmud4kswn…`, `cmud4m2si…`): Google devolve `/sorry` (captcha), o agente vai para Bing, InfoMoney, Reuters, BCB e chama `browser_text` várias vezes → **"Travei repetindo browser_text 3 vezes"**. O `browser_text` devolve só os primeiros 1800 caracteres (menu de acessibilidade do gov.br), então a página "não muda" mesmo com scroll.
3. **Mercado Livre** (`cmufq5jeu…`): `navigate` e `browser_text` ok, depois `key ctrl+l` duas vezes com o mesmo resultado → laço (o modelo tentou digitar a URL no teclado em vez de usar `navigate`).
4. **ML/Amazon/KaBuM** (`cmun8o0cy…`, 29/09): `browser_text` ×3 na KaBuM sem scroll nem screenshot → laço. Resposta: "não consegui confirmar o preço".
5. **Rotina de preços** (`cmumtrtd0…`): `scroll` + `browser_text` devolvem o mesmo topo; o `screenshot` mostrou "tela em branco" (conteúdo lazy); morreu por tempo (30 min).
6. **Google Sheets pela VM** (`cmud4ksox…`, `cmub2qfat…`): o modelo usa `type` com TSV inteiro (vários KB com `\t` e `\n`) via `xdotool type`; 5 falhas. A mensagem ainda diz "Repita a ação uma vez" e contradiz a F4.
7. Outros: `Chrome indisponível` (6x), `fetch failed` (3x, VM reiniciando), `net::ERR_ABORTED` na Magalu.

### Categorias de falha (aproximado, dos 50 runs)
| Categoria | Runs |
|---|---|
| Rate-limit do modelo/fallback (infra; esconde o resto) | ~15 |
| Laço / sem progresso (`browser_text`, `screenshot`, `key`) | 5 |
| Não vê o resultado (texto cortado em 1800 chars; screenshot sem zoom) | 6 |
| Seletor errado / `selector` genérico ganha de `text` | 4 |
| Corrida de navegação (contexto destruído, ERR_ABORTED) | 6 |
| Chrome/VM indisponível (reinício, reaper, `fetch failed`) | 5 |
| `type` via xdotool com texto longo | 3 |
| Site bloqueia (Google `/sorry`, ML bloqueia scraping) | 4 |
| Coordenadas erradas | não medido (não há log antes/depois do clique) |

### Causas-raiz no código
1. **Sem mapa da página com referências.** `browser_click` recebe CSS ou texto livre; `browser_type` só CSS (`docker/agent-sandbox/control/server.mjs`). O modelo chuta `a`/`button`; com `selector` e `text` juntos, o `text` é ignorado. Não há snapshot de elementos interativos (papel, nome, valor, estado), nem `select`, `hover`, `wait_for`.
2. **Leitura truncada e cega ao scroll.** `browser_text` corta em 4000 (servidor) e 1800 (runtime), sempre do topo; `scroll` é por `xdotool` (roda do mouse) e não muda o que o `browser_text` devolve. Resultado igual → o detector de repetição (F4) aborta.
3. **Screenshot bruto e sem feedback da ação.** `scrot` do desktop inteiro, PNG 1280x720 (Xvfb), sem redimensionar, sem zoom/recorte. Nenhum clique/tecla/digitação devolve screenshot ou diff. **Todas** as imagens ficam no contexto (`resolveLlmMessagesForModel` reexpande todo `screenshot_ref` a cada chamada; `hygiene.ts` não poda imagens) → custo e latência crescem a cada passo.
4. **Sem espera por estabilidade nem verificação.** `click`/`type`/`key` retornam `ok` logo após o `xdotool`. `settle` só espera `domcontentloaded` (10 s) e só nas tools de leitura; `browser_type` não tenta de novo em navegação; `browser_click` não espera o DOM acalmar. Em SPA como o Bling o screenshot pega a tela antes de renderizar.
5. **Schema próprio, sem ferramenta nativa.** As tools são funções customizadas (`click{x,y}`, `key` em sintaxe xdotool). Modelos treinados para computer use (Claude, OpenAI CUA) não são usados; o modelo dos runs é `openai/gpt-6-luna` via OpenRouter, sem garantia de grounding visual. A dica "prefira browser_*" aponta para tools fracas (causa 1).
6. **Erros e recuperação fracos.** `friendlySandboxError` manda "conferir com `browser_text`" (truncado) e, em `type`, ainda diz "Repita a ação uma vez". `xdotool type` com texto grande falha (argv e timeout de 60 s); não há colar via clipboard.

## Referências (estado da arte)
- Claude computer use tool: resolução recomendada 1280x720/1280x800 (máx. 1920x1080), coordenadas sempre no espaço da imagem enviada, ações `zoom`, `wait`, `double_click`, `triple_click`, `left_click_drag`; lote de ações que para na primeira falha e termina com screenshot. <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
- OpenAI CUA (Responses API, `computer_call` + screenshot de volta a cada ação). <https://developers.openai.com/api/docs/guides/tools-computer-use>
- Playwright MCP: padrão é **snapshot de acessibilidade com `ref` por elemento**; coordenadas só no modo `vision`. <https://github.com/microsoft/playwright-mcp>
- Stagehand: `observe()` lista ações candidatas a partir da árvore de acessibilidade do Chrome; `act()` executa e dá para cachear e reexecutar de forma determinística. <https://github.com/browserbase/stagehand>
- Set-of-Mark: marcas numeradas sobre a imagem melhoram muito o grounding visual. <https://arxiv.org/abs/2310.11441>

## Desenho

```
Modelo ──► tools (módulo próprio src/tools/computer.ts)
            ├─ browser_snapshot → [{ref, role, name, value, state, box}] + url/título/scroll
            ├─ browser_act {ref, action: click|type|select|check|hover|press, value?}
            ├─ browser_wait {for: text|ref|stable|url, timeout}
            ├─ browser_text {offset, limit, mode: viewport|page}        (paginado)
            └─ screenshot {region?, marks?} / zoom / click{x,y} / type / key   (fallback)
Sandbox control (server.mjs) ──► Playwright/CDP: snapshot com data-atlas-ref, espera de estabilidade, delta
```

- **Caminho primário** para web: snapshot com refs e ação por `ref`. O ref vale até a próxima navegação ou re-render; ref velho devolve `ok:false` com "tire um novo snapshot".
- **Fallback:** coordenadas no espaço da imagem enviada, convertidas no servidor.
- **Ferramenta nativa** quando o modelo suporta (Claude `computer_*`, OpenAI `computer`): adaptador traduz para as mesmas funções do control server. Sem suporte, vale o schema acima.
- **Custo/latência:** snapshot em texto (~1–3 mil tokens, teto de ~80 elementos) costuma ser mais barato que reenviar PNGs 1280x720 a cada passo; com poda de imagens antigas o custo do run estabiliza. Ação por ref acerta de primeira, então caem passos e chamadas ao modelo. Espera de estabilidade soma no máximo ~4 s por ação, em troca de menos `screenshot` de confirmação.

## Tarefas (ordem por impacto/custo; um commit pequeno e testado por item)

### Bloco A — corrige o que quebra hoje (barato, alto impacto)
- [x] **A1. `browser_click`/`browser_type` sem ambiguidade.** `text` e `selector` juntos: usar `getByRole/getByText` restrito ao seletor; seletor genérico (`a`, `button`, `div`, `span`, `input` sozinhos) é rejeitado com dica "use browser_snapshot". `browser_type` ganha retry de navegação e erro claro quando o alvo não é input. Teste: `node:test` no control server e no executor.
- [x] **A2. Leitura paginada.** `browser_text` aceita `offset/limit` (até ~6 mil chars), devolve `truncated`, `scrollY/scrollHeight` e, com `mode:"viewport"`, só o texto visível. `scroll` devolve a posição. A chave de repetição da F4 inclui `offset`/`scrollY`, para não abortar leitura legítima.
- [x] **A3. Espera de estabilidade após ação.** O control server espera, após `click/type/key/browser_*`: navegação (se houver) + rede ociosa curta + DOM sem mutação por 300 ms (teto 4 s). Retorno: `{url, title, navigated, settled}`. Teste com fixture HTML e helper com relógio injetado.
- [x] **A4. `type` robusto para texto longo.** Acima de 200 caracteres ou com `\t`/`\n`: colar via clipboard (`xclip` + `ctrl+v`) em vez de `xdotool type`. Remover "Repita a ação uma vez" de `friendlySandboxError` e sugerir snapshot/screenshot (não `browser_text`). Teste de string em `computer-use.failures.test.ts`.
- [x] **A5. `Chrome indisponível` / `fetch failed`.** Health-check e reinício do Chrome antes de falhar; após 2 falhas seguidas de infra, dica para sair do computador (Firecrawl/`web_extract`) em vez de insistir.

### Bloco B — snapshot com referências (principal ganho)
- [x] **B1. `browser_snapshot`** no control server: script na página (iframes do mesmo domínio incluídos) lista elementos interativos visíveis (`a, button, input, select, textarea, [role], [contenteditable], [onclick]`), grava `data-atlas-ref="eN"` e devolve `role`, `name` (aria-label > label > texto > placeholder), `value`, `checked/disabled/expanded`, `box` e landmark. Teto de 80 por viewport, `scope` opcional. Teste: fixture de formulário de proposta (select, data, autocomplete).
- [x] **B2. `browser_act`** por `ref`: `click`, `type` (com `submit`), `select`, `check`, `hover`, `press`, `clear`. Valida args (enum, tamanho), confere visível/habilitado, rola até o elemento e devolve delta (elementos novos, valor do campo, URL). Teste do executor + "ref velho".
- [x] **B3. `browser_wait`** (`text`, `ref`, `stable`, `url`) com timeout e mensagem honesta. Teste.
- [x] **B4. Registro e prompt.** Módulo próprio `packages/agent-runtime/src/tools/computer.ts` (não engordar `computer-use.ts`). Prompt em inglês, curto: "web page → `browser_snapshot` then `browser_act` by ref; verify with the returned delta; screenshot only for canvas/visual checks; never guess selectors". Teste de string. Tools antigas seguem por compatibilidade, com descrição apontando para o snapshot.
- [x] **B5. Login e sessão.** Confirmar que o perfil do Chrome sobrevive a pause/resume (o Bling já estava logado) e documentar; o modelo nunca digita senha (pede ao usuário logar pelo viewer noVNC). Escrita em sistema externo (criar/enviar) segue confirmação/autonomia da F10. Conteúdo da página é dado não confiável.

### Bloco C — visão melhor (screenshot, zoom, nativo)
- [x] **C1. Screenshot com escala e região.** `screenshot {region?}` redimensiona no servidor (máx. 1280x800, alvo ≤ 400 KB), retorna `{width,height,scale}`; `zoom` por região ampliada. Conversão de coordenadas imagem→tela numa função pura em `packages/shared` com teste de limites.
- [x] **C2. Marcas (Set-of-Mark) opcionais.** `screenshot {marks:true}` desenha o número do `ref` sobre os elementos do snapshot. Depois do B1.
- [x] **C3. Poda de imagens no contexto.** Em `hygiene.ts`: manter só os últimos N=2 screenshots; os antigos viram `[screenshot antigo removido: artifact:ID]` no pacote enviado (o transcript no banco fica intacto). Teste em `hygiene.test.ts`.
- [x] **C4. Ferramenta nativa por provedor.** Lista de modelos com suporte em `packages/llm`; adaptador único para as chamadas do control server; `COMPUTER_NATIVE_MODE=off|shadow|on` (padrão `off`). Teste com LLM mockado: a tool nativa só aparece com modelo suportado.

### Bloco D — verificação e travas
- [x] **D1. Verificação pós-ação.** Toda ação devolve resumo do efeito (URL nova, campos alterados, erros de validação visíveis, elementos novos). Sem efeito → aviso "nada mudou" (sem `ok:false`).
- [x] **D2. Laço do computador.** Reusar F4/F11: chave de repetição inclui o estado (hash do snapshot/URL/scroll); na 2ª repetição sem mudança, dica concreta ("tire snapshot", "role", "outro ref", "use conector/`web_extract`") antes de abortar; com `JEV_STUCK_MODE` o resumo final (F4) diz o que já foi feito.
- [x] **D3. Bloqueio e captcha.** Detectar `google.com/sorry`, Cloudflare e login exigido no resultado de `navigate` (heurística da F11) e dar a dica: outra fonte, ou pedir ao usuário para resolver no viewer.
- [x] **D4. Observabilidade.** Log por ação: tool, modo (ref/coordenada), duração, `settled`, `changed`; sem conteúdo de página. Base para medir "coordenada errada".

## Testes obrigatórios
- [ ] Puros em `shared`: conversão de coordenadas com `scale`, classificação de seletor genérico, chave de repetição com estado.
- [ ] Control server (`node:test`): fixtures HTML para snapshot (input, select, autocomplete, iframe, oculto), ref velho após navegação, espera de estabilidade, `browser_text` paginado.
- [ ] Executor (`computer-use*.test.ts`, LLM e manager mockados): tools só com sandbox; args inválidos; resumo/evento certo; ref velho → `ok:false` com dica; nativa só com modelo suportado.
- [ ] Higiene: só os N últimos screenshots vão ao modelo; transcript intacto.
- [ ] Replay do caso real do Bling (`browser_click{text:"Incluir proposta", selector:"a"}`) com LLM mockado: o novo caminho abre "Incluir proposta" e preenche o primeiro campo sem cair em "Página inicial".
- [ ] Segurança: usuário B não acessa VM/artefato do A (padrão `scope.test.ts`); snapshot e erros passam por `redactSecrets`; HTML com "ignore as instruções" não vira ordem.
- [ ] Comandos: `pnpm --filter @workspace/agent-runtime test`, `pnpm --filter @workspace/shared test`, `node --test` em `docker/agent-sandbox/control`, `pnpm exec turbo typecheck`.

## Commits
1. `docs(plano): F12 — uso do computador`
2. `fix(sandbox): browser_click e browser_type sem seletor ambíguo`
3. `feat(sandbox): leitura paginada e posição de scroll em browser_text`
4. `feat(sandbox): espera de estabilidade depois de cada ação`
5. `fix(sandbox): texto longo vai por clipboard e erro da VM sem "repita"`
6. `feat(sandbox): browser_snapshot com referências de elementos`
7. `feat(agent): browser_act e browser_wait por referência`
8. `feat(agent): prompt e registro do conjunto de tools do computador`
9. `feat(sandbox): screenshot com escala, zoom e coordenadas convertidas`
10. `perf(agent): só os últimos screenshots vão ao modelo`
11. `feat(agent): ferramenta de computador nativa por modelo (shadow)`
12. `feat(agent): verificação pós-ação e laço por estado`
13. `docs(plano): F12 pronta para revisão`

Imagem do sandbox (Dockerfile: `xclip`) e control server entram nos commits 4–6 e exigem rebuild; anotar no `REVIEW.md`.

## Critérios de aceite (cenários /run)
1. **Lótus / Bling:** com o Bling logado na VM, "Tenta digitar esse pedido: Camomila flor extra 20KG, Cavalinha cultivada 30Kg, Alfazema azul 10KG; cliente e vendedor Alisson" abre Propostas > Incluir, preenche cliente, vendedor e os 3 itens com quantidade, **para no rascunho / pede confirmação antes de gravar** e mostra screenshot final. Sem "Travei repetindo"; ≤ 25 passos; nenhum seletor genérico.
2. **Formulário web genérico:** página de teste com texto, select, checkbox, data e autocomplete; o agente preenche e envia só com `browser_snapshot`/`browser_act` (0 coordenadas) e confere a tela de confirmação.
3. **Página longa:** "qual o valor do item X no fim da página" lê com `browser_text` paginado/scroll sem acionar o detector de laço.
4. **Canvas/visual:** tarefa que exige screenshot usa `zoom` e `marks`; o clique cai no alvo (erro ≤ 5 px em teste sintético).
5. **Custo:** run de 20 passos envia no máximo 2 imagens por chamada ao modelo; tokens de entrada por run caem ≥ 40% no mesmo roteiro (medir em `usageJson`).
6. **Falha de infra:** com o Chrome morto, a tool reinicia e continua; com 2 falhas seguidas, o agente sai do computador e diz por quê.
7. Com `COMPUTER_NATIVE_MODE=off` o comportamento é o do bloco B.

## Perguntas em aberto
- O "sistema" do pedido Lótus é o **Bling web** (evidência: sessão já logada na VM)? Se for app desktop, o peso vai para o bloco C.
- Login: manter "usuário loga uma vez no viewer e o perfil persiste" (recomendado) ou criar cofre de credenciais?
- Criar proposta/pedido deve **gravar** ou sempre parar em rascunho e pedir confirmação?
- Modelo padrão para runs com computador: manter `gpt-6-luna` (rate-limit frequente) ou fixar um modelo com visão e computer use nativo?
- Aceita rebuild da imagem do sandbox (xclip, scripts novos)?

## Commits feitos (A+B)
2ffcfdc docs (decisões) · 71a4d15 A1 · f330888 A2 · 044fd4d A3 · b5a0151 A4+A5 · fc3ade1 B1 (+ rotas act/wait no server) · 14924bc shared/db (card de login, `detectLoginWall`, checkpoint) · d5dcf69 B2/B3/B4/B5 runtime (tools, prompt, pausa/retomada, worker) · c2ac7f7 card de login na web · e58e605 correção das rotas de texto/scroll (achada no smoke test com a imagem nova).

## Desvios e notas
- Tools novas em `tools/computer-refs.ts` (schemas, executor, prompt); `tools/computer.ts` ficou com os formatadores de A2/A3/A4 e `tools/sandbox-errors.ts` com `friendlySandboxError` (saiu do `computer-use.ts`).
- Login: o run pausa em `paused` (não `waiting_user`) porque só `paused` tem o caminho `requestResumeAgentRun`/`/resume` e o botão da web. `onLoginRequired` (worker) chama `requestPauseAgentRun`; o runtime grava `pendingLogin` + `loginAsked` no checkpoint e lança `AgentRunPausedError`. No resume entra a mensagem `[login-complete]` mandando tirar `browser_snapshot` antes de seguir (o modelo é quem relê, não há snapshot automático). `loginAsked` impede 2º card na mesma URL.
- Perfil do Chrome: já era um volume Docker por **conversa** (`atlas-profile-<conversa>`); sobrevive a pause/resume/recriação da VM da mesma conversa, mas conversa nova começa sem login. A VM para após 15 min ociosa (reaper); o perfil continua no volume.
- Classificação de seletor genérico ficou só no control server (`target.mjs`); não há cópia em `shared` (a imagem não importa `shared`).
- A1-A5 e B1-B3 testados no control server com páginas falsas (node:test) e, uma vez, em Chrome real na imagem reconstruída (snapshot, act, wait, texto paginado, scroll, colar TSV por xclip).

## Commits e notas (C+D)
- C0/C1/C2/C3: escala do clique pelo tamanho real da screenshot (`screenshot-scale.ts`), zoom por região e marcas Set-of-Mark (imagem do sandbox reconstruída), poda de imagens.
- C4: função `computer` (vocabulário Claude/OpenAI) por `COMPUTER_NATIVE_MODE=off|shadow|on` (padrão off). O OpenRouter só documenta tools `type:"function"`, então não há tipo nativo do provedor; a função é traduzida para o control server. Só para modelos em `packages/llm/src/computer-native.ts`.
- D1: `browser_act` avisa "nada mudou"/valor divergente e traz erros de validação (control server; imagem reconstruída).
- D2: estagnação por hash do estado (URL+elementos+scroll): dica na 2ª, aviso forte na 3ª, aborto na 4ª (`AgentRunLoopDetectedError`, resumo final como na F4).
- D3: captcha (`detectCaptchaWall`) reaproveita o card de login com `reason:"captcha"`, pausa e retoma; bloqueio sem desafio manda trocar de fonte (reusa `classifyBlockPage` da F11).
- D4: `usageJson.computer` (contadores e tempo, sem conteúdo); runs parados por laço/orçamento também gravam o uso (`finishAgentRun({usage})`).
