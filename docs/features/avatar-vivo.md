# Avatar vivo

- **Status:** entregue (aguardando o ok do dono nas prévias)
- **Data:** 2026-10-30
- **Issues/PRs:** #

## O que é
O avatar do bot passa a mostrar o que ele está fazendo: pensando, pesquisando, lendo, programando, escrevendo, esperando você, errando ou terminando. E o movimento deixa de se repetir: enquanto o bot trabalha o avatar se mexe de um jeito sempre um pouco diferente.

## Problema
O avatar animado "repetia sempre as mesmas coisas enquanto trabalha". Causa, conferida no código:
- O app só passava dois estados ao avatar (`working` ou `idle`, em `live-agent-avatar.tsx`). Seis estados da tabela (`reading`, `working`, `coding`, `running`, `computing`, `controlling`) usam a mesma definição de seis clipes, então Lendo e Programando eram idênticos mesmo que alguém os pedisse.
- A atividade real (pensando, ferramenta, escrevendo, passo 3 de 8) já existia, mas só alimentava o texto do indicador (`AgentActivity` em `working-status.ts`). Ainda por cima o indicador sorteava um rosto (atento/curioso) que sobrescrevia o rosto do estado.
- O anel de progresso girava num ciclo fixo, sem receber fração.
- Os clipes são uma lista finita sorteada em "bolsa": depois de alguns minutos a sequência é reconhecível.

## Por que existe
Dar ao usuário um sinal visual honesto do que o bot faz (sem texto) e tirar a sensação de "boneco em loop". Sem clipes novos desenhados à mão: reaproveita os estados, o morph de indicador e o motor puro que já existem.

## Alternativas descartadas
- **Desenhar clipes novos à mão para cada atividade:** caro (cada clipe são dezenas de keyframes por forma), continua sendo uma lista finita que se repete, e não reage a eventos do run. Fica como evolução possível, por cima do cérebro.
- **Sortear variação aleatória nos clipes (jitter):** sem memória nem correlação, parece tremor; não diferencia atividades.
- **Rede treinada / modelo de movimento:** dependência e peso sem ganho visível a 36 px; a rede fixa semeada pelo id do bot já dá o "nunca idêntico" de forma determinística e testável.
- **Mostrar o anel de progresso o tempo todo:** esconde o estado da ferramenta (Lendo × Programando). O anel acende por 1 s num passo novo, no máximo uma vez a cada 4 s.

## Como funciona
Fase A: atividade real nos estados que já existiam.
- `apps/web/lib/avatar-activity.ts`: função pura `avatarStateForActivity(activity, ctx)`. thinking → `thinking`; writing → `streaming`; revising → `thinking` (o rascunho some do chat, então digitar mentiria); ferramenta → `searching` (navegar, web), `reading` (ler, memória, captura de tela), `coding` (escrever/editar arquivo), `running` (shell, código), `controlling` (clicar, digitar, rolar), `working` (o resto); esperando você, aprovação, fila ou pausa → `waiting`. Usa `toolKind` de `working-status.ts` (a mesma classificação do texto; as frases do indicador não mudaram).
- `apps/web/lib/avatar-governor.ts`: puro, com `now` injetado. Cada estado dura no mínimo 1,2 s e, se o bot trocar de ferramenta várias vezes nesse tempo, só a última vale. Passo novo acende o anel de progresso por 1 s com a fração (passo + 1) / total (a mesma do texto "passo 3 de 8"), no máximo uma vez a cada 4 s (senão um run com passos rápidos viraria só anel e esconderia Lendo e Programando). Repouso e "trabalhando" genérico não seguram a troca: o primeiro estado de atividade entra na hora. Falha de ferramenta mostra `failed` por 1,8 s e o fim do run ok mostra `finished` por 2,6 s, e só então volta ao que fazia / repouso.
- `apps/web/lib/bot-activity.ts`: além de "trabalhando", guarda a atividade por bot (publicada pelo `ChatThread` via `use-avatar-activity.ts`). `useBotAvatar` devolve `{ state, progress }` para sidebar, cabeçalho e indicador. Run só do servidor (rotina, outro aparelho) continua virando `working`.
- `packages/shared/src/avatar/model/indicator.ts`: o anel aceita fração real (`engine.setProgress(f)`): anima até o valor, fica cheio e mais grosso (legível a 36 px). Sem fração, o ciclo antigo.
- `working-indicator.tsx` não força mais `expression`: o rosto vem do estado e do clipe.
- `states.ts`: Lendo (olhos calmos), Programando (olhos apertados, focados) e Mexendo na tela (olhos curiosos) ganham rosto próprio sobre os mesmos seis clipes de trabalho. Só o cérebro não bastava: a 36 px o giro extra some perto do giro dos clipes (±20°).

Fase B: cérebro (`packages/shared/src/avatar/model/brain.ts`).
- Rede recorrente fixa, sem treino: 20 nós leaky (tanh), pesos sorteados da semente do bot. Entradas: família de atividade (misturada suavemente), pulsos (`toolStart`, `toolOk`, `toolFail`, `tokens`), tempo desde o último evento e quatro marcapassos (senoides de períodos 7,1 · 4,3 · 2,9 · 1,7 s). Sem os marcapassos a rede convergia para um ponto fixo (medido: desvio ~0,02° em 55 s); com eles ela segue se mexendo e nunca repete. Ganho 2,2 (regime caótico) e tanh: nunca estoura.
- Saídas pequenas somadas por cima do clipe em `character.ts`: giro da cabeça (yaw/pitch/roll, até 7°/6°/4°), olhar dos olhos, achatar/esticar, respiração e a taxa de piscadas (`behavior.ts`). Peso sobe em ~0,8 s ao trabalhar e volta exatamente a zero ao parar.
- Cada família tem um perfil (andamento, viés, amplitude): Lendo = cabeça levemente baixa, varredura lenta e larga dos olhos, pisca menos; Programando = cabeça baixa, olhar fixo, tremor rápido e "toques", pisca menos ainda; Pesquisando = varredura rápida; Pensando = olha para cima e inclina; etc.
- API: `engine.pulse(kind, strength)`, `engine.setActivity(family | null)` (por padrão a família vem do estado). O `ChatThread` gera os pulsos pela mudança de atividade (`bot-activity.ts`), o `LiveAgentAvatar` os repassa ao motor.
- Ticker: `engine.isSettled()` é falso enquanto o cérebro está ativo; fora da tela e aba oculta continuam pausando como antes. Com "reduzir movimento" o avatar segue o quadro estático (nem cria o motor). Avatar com menos de 32 px não tem cérebro.

## Riscos
- Tabela de estados/tipos: `AgentActivity` ganhou `toolFailed` no ramo `thinking` (opcional; quem não conhece ignora). Sem mudança de API, banco, eventos SSE ou migration.
- Rodar mais tempo no loop: avatares com cérebro não dormem enquanto o bot trabalha (já era assim com os clipes de trabalho); parado, volta a dormir (testado).
- Flicker: coberto pela permanência mínima e testes do governador.
- Cancelamento pelo usuário hoje termina como "ok" (comemora brevemente), pois o `ChatThread` só sabe se há erro. Anotado como limitação.
- Rajada de texto (`tokens`) existe no motor, mas o hook de chat ainda não a publica (o estado Escrevendo já tem o seu próprio andamento).

## Custo
Sem custo de infra nem de tokens (tudo no cliente). Desempenho de `engine.advance` por quadro (node, 10 mil quadros, mediana de 7 rodadas, máquina compartilhada, então ±2 µs de ruído; `heart`, 56 px):

| Caso | Antes (base) | Depois sem cérebro | Depois com cérebro |
|---|---|---|---|
| repouso (respirando) | 3,8 µs | 2,2 µs | 2,2 µs (cérebro dorme) |
| trabalhando / lendo / programando | 3,0–4,8 µs | 2,1–2,5 µs | 4,9–5,4 µs |
| pesquisando (radar) | 7,6–11,1 µs | n/m | 6,6 µs |

O cérebro custa ~2,5–3 µs por quadro (≈ 0,03% de um quadro de 16,7 ms) e só enquanto o bot trabalha. Para comparação, o quadro inteiro (advance + SVG em texto) custa ~390–470 µs. A rede faz 2 a 8 passos de 1/60 s por quadro (20×(20+15) multiplicações cada). Avatares com menos de 32 px, fora da tela, em aba oculta ou com "reduzir movimento" não gastam nada.

## Como testar
- `pnpm --filter @workspace/shared test` (indicator, brain), `pnpm --filter @workspace/ui test` (ticker, avatar), testes do web: `avatar-activity`, `avatar-governor`, `bot-activity`, `working-status`, `live-agent-avatar`.
- Prévias em vídeo (demo, antes | depois) e quadro Lendo × Programando.
