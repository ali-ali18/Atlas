# F11 — Decisões baratas com Jev (intenção, tools, verificação, bloqueio, delegação, travamento)

**Dono:** Bot B (runtime) · **Depende de:** F10 (autonomia), F5 (`delegate_task`), F4 (resumo final), branch `feat/jev-mcp` (cliente Jev + `jev-gate`) · **Status:** pronta para revisão

## Decisão do usuário (30/09)
- Usar o Jev (`typesafe/jev-1.13`: entrada ~US$0,004, saída grátis) para decisões pequenas do runtime, em qualquer idioma.
- Uma chave por item: `JEV_<X>_MODE=off|shadow|on`. `off` é o padrão no código; `shadow` chama o Jev e registra, mas mantém o comportamento atual.

## Diagnóstico
- Detectores de intenção são regex em pt-BR (`looksLikeProfileChangeRequest`, `looksLikeAutonomyRequest`, `looksLikeSubagentModelRequest`, cancelar/confirmar em `skill-intent.ts`): falham em inglês, espanhol etc.
- O modelo de conectores com índice adiado gasta passos para achar as tools (`mcp_tool_search`).
- A resposta final pode contradizer a evidência (diz "não confirmei" com o preço na mão, culpa tool que funcionou).
- Páginas de bloqueio (Cloudflare, captcha, cookie) voltam como `ok:true` e o modelo as trata como conteúdo.
- O modelo nem sempre percebe que o pedido se divide em tarefas independentes.
- Run travado só é pego por heurística de repetição (F4), não por falta de progresso.

## Regras comuns
- Cliente único: `askJev` em `packages/llm` (perguntas `noul` → probabilidades) e helper `decideWithJev` em `packages/agent-runtime/src/jev/decide.ts`.
- Timeout estrito de 1,5–3 s por chamada; **fail-safe**: erro, timeout ou resposta malformada → comportamento de hoje.
- Contexto mínimo: truncado e passado por `redactSecrets`. Só a **última mensagem do usuário** para intenção (nunca resultado de tool).
- O Jev nunca concede permissão: autonomia, `toolFilter` e orçamento continuam decidindo.
- Log de depuração só com `JEV_<X>_DEBUG=1`, sem conteúdo (só feature, modo, números, duração).

## Tarefas
- [x] Helper compartilhado (`askJev`, `decideWithJev`, `parseJevFeatureMode`, redação/truncamento) + config do worker.
- [x] **Intenção** (`JEV_INTENT_MODE`): uma chamada por turno com perguntas sim/não sobre a última fala do usuário (perfil, autonomia, modelo do subagente, cancelar, confirmar). `on`: Jev sim **ou** regex sim. Regex continua o caminho rápido.
- [x] **Pré-seleção de tools** (`JEV_TOOLS_MODE`): antes do 1º passo, com toolset adiado, o Jev escolhe até 8 tools de leitura do índice; ativação pelo caminho existente (autonomia/orçamento/`toolFilter`).
- [x] **Verificador de resposta** (`JEV_VERIFY_MODE`): antes de fechar a resposta (com tools usadas), confere rascunho x evidência; contradição → UMA nota de sistema e uma revisão (sem laço).
- [x] **Página de bloqueio** (`JEV_BLOCKPAGE_MODE`): heurística barata primeiro; Jev só nos casos ambíguos; dica em inglês no resultado (stealth no Firecrawl, ou outra fonte).
- [x] **Delegação** (`JEV_DELEGATE_MODE`): no início do chat, se `delegate_task` está exposta, o Jev diz se o pedido divide em 2–3 partes independentes; `on` injeta dica.
- [x] **Travamento** (`JEV_STUCK_MODE`): a cada 6 passos depois do 8º, trilha compacta ao Jev; "travado" (`on`) dispara o resumo final da F4 sem tools.
- [x] `.env.example` do worker (e api, se ler) com as chaves, sem valor.

## Orçamento de latência
- Início do run: intenção, pré-seleção e delegação em paralelo (teto ~2,5 s, tipicamente < 1 s).
- Verificador: +1 chamada só quando há resposta final com tools usadas (teto 3 s).
- Bloqueio: só para scrape/extract ambíguo (teto 2 s). Travamento: 1 chamada a cada 6 passos (teto 2 s).

## Testes obrigatórios
- [x] `askJev`/`decideWithJev`: sucesso, timeout, malformado, `off` não chama, `shadow` chama e não muda, abort do usuário propaga.
- [x] Intenção: inglês/espanhol expõem `set_autonomy` e `propose_profile_update`; `off` = só regex; injeção dentro de resultado de tool não muda a exposição; só a última fala do usuário vai ao Jev.
- [x] Pré-seleção: "preço em 3 lojas" pré-carrega firecrawl search/scrape; nada em falha; respeita `toolFilter`/autonomia.
- [x] Verificador: contradição → 1 revisão; limpo → nenhum passo extra; falha → inalterado; `shadow` não revisa.
- [x] Bloqueio: heurística clara sem Jev; ambíguo → Jev; dica só em `on`.
- [x] Delegação: dica só com `delegate_task` exposta e `on`.
- [x] Travamento: só depois do 8º passo, a cada 6; `on` → resumo final; `shadow` segue.

## Commits
1. `docs(plano): F11 — decisões com Jev`
2. `feat(agent): Jev detecta intenção em qualquer idioma`
3. `feat(agent): Jev pré-seleciona tools dos conectores`
4. `feat(agent): Jev confere a resposta contra as evidências`
5. `feat(agent): Jev reconhece página de bloqueio`
6. `feat(agent): Jev sugere delegar tarefas independentes`
7. `feat(agent): Jev detecta run travado`
8. `docs(plano): F11 pronta para revisão`

## Critérios de aceite
- Com as seis chaves em `on`: "please stop asking me before acting for a week" expõe `set_autonomy`; "preço em 3 lojas" já começa com as tools do Firecrawl; página do Cloudflare vira dica de stealth; resposta que nega o que a tool trouxe é revisada uma vez; run em círculos termina com resumo.
- Com as chaves `off` (ou Jev fora do ar), nada muda em relação a hoje.

## Commits feitos
1d37670 docs plano · 2f17667 intenção (+ `askJev`, `decideWithJev`) · b885683 pré-seleção de tools · d3db18b verificador de resposta · e8d13e0 página de bloqueio · 793af7c delegação · c2fe294 run travado · (worker) test das chaves JEV_*_MODE

## Decisões e limites
- `askJev` (packages/llm) é o cliente genérico; `evaluateMcpWithJev` passou a usá-lo. Só perguntas `noul` (probabilidade): o Jev não gera texto. Por isso a dica de delegação não traz a divisão proposta e a nota do verificador usa texto fixo por tipo de problema.
- Limiares: intenção 0,8 (confirmar 0,9), pré-seleção 0,6, verificador 0,8, bloqueio 0,8, delegação 0,8, travado 0,85.
- Cancelar/confirmar (API, `skill-intent.ts`): o Jev só é consultado com card de confirmação pendente e fala curta (<= 80) que o regex não reconheceu; cancelar vence confirmar.
- O rascunho revisado pelo verificador já foi transmitido ao vivo; na tela aparece o rascunho e depois a revisão (o texto persistido é o revisado).
- Subagentes herdam só a detecção de bloqueio.
