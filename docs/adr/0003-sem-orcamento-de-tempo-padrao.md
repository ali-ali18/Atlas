# ADR 0003: sem orçamento de tempo padrão; o bot vai até o fim

- **Status:** aceito (decisão do dono em 02/11: "remover esse orçamento")
- **Data:** 2026-11-02

## Contexto

O bot vivia parando com "O limite desta tarefa…" e entregando pela metade. No motor novo (ADR 0002) o chat tinha 8 min de tempo ativo e o trabalho longo 60 min, com aviso a 80% (`WRAP_UP_NOTE`) e entrega forçada sem tools (`deliveryInstruction`). O motor anterior tinha teto de parede de 30 min (`BUDGET_WALL_DEFAULT_MS`) e soft de 24 passos. A conta ainda herdava 30 min como teto duro do run.

O pedido do usuário no chat não termina por relógio: ele termina quando o trabalho acaba. Um relógio padrão só trocava "bot faz o que foi pedido" por "bot faz o que cabe em N minutos", e o usuário via isso como defeito.

Investigando as paradas no meio, apareceram mais quatro causas além do relógio, tratadas na mesma entrega porque o objetivo é um só (fazer até o fim o que foi pedido):

1. A **estagnação** (4 passos sem item concluído nem entrada nova no caderno) mandava escrever e tirava `browser_act`/`sandbox_*` do modelo no meio de um pedido de ação.
2. "**Vou fazer X**" sem tool call encerrava o turno: o motor novo não tinha o stall-guard do anterior.
3. "**Continua**" digitado recomeçava do zero (perfil `chat`, sem lista nem caderno).
4. Pedido de ação em site ("abra o Gemini e peça um resumo") caía no modo chat curto.
5. **Espera virava repetição**: 4 `sandbox_shell_wait` iguais davam `loop_repeat`.

## Decisão

- Nenhum perfil nem motor tem tempo máximo por padrão (`maxActiveMs = Infinity`; v1 com `maxWallMs = 0` e soft igual ao hard). Sem aviso de 80% nem entrega forçada por tempo; a promoção chat → trabalho longo por tempo deixou de existir (fica a da lista de 3+ passos e, agora, a da 1ª tool de navegador/VM).
- **Continuam valendo só os tetos que o dono configura de propósito:** teto da conta ou do bot em US$, tempo máximo da conta, e o gasto e os minutos do bot no trabalho longo (`longWorkBudgetUsd`, `longWorkMinutes`, agora ambos opcionais na UI e no `set_engine`; vazio ou 0 = sem limite). O aviso de 80% e a entrega valem só nesses casos.
- **Redes de segurança contra laço (não são orçamento):** `MAX_STEPS_SAFETY` (200), nota e aborto por repetição (mesma tool, args e resultado; agora com 2 notas antes do aborto e esperas isentas até 30 seguidas), bloqueio por falhas seguidas (chave tool + alvo), estagnação do trabalho longo (8 passos sem resultado novo; resultado novo de tool conta como progresso, captura de tela não), portões de lista e de documento de no máximo uma ou duas atuações por run, e o botão de parar. O `BUDGET_HARD_CAP` (300) do motor anterior fica.
- **Rotina, alerta, proativo, brief e bot→bot mantêm o limite de antes** (8 min no chat curto, 30 min no brief, lembrete `check`, trabalho longo e motor anterior; os minutos do bot ou o tempo da conta, se configurados, valem mais). Sem humano olhando e sem botão de parar à mão, laço lento é custo silencioso. Os ajudantes (`delegate`) mantêm o tempo por ajudante do `planHelperBudgets` (`HELPER_MAX_MS`) e os subagentes do v1 os seus.
- O status `budget_exhausted` e os motivos `budget_*` continuam existindo (teto do dono, passos de segurança). Contrato SSE e status persistidos não mudam.

## Alternativas descartadas

- **Subir o tempo (8 para 30 min, 60 para 180):** só adia o corte; o pedido de 40 minutos continua truncado e o aviso continua aparecendo.
- **Só aumentar o aviso/entrega para depois dos 100%:** mantém o relógio como árbitro da qualidade da resposta.
- **Tempo infinito também em rotina:** o dono pediu "remover esse orçamento" falando do chat; rotina sem limite seria um risco de custo que ninguém pediu.

## Consequências e riscos

- **Custo de run longo:** um run pode gastar muito sem o relógio. Mitigação: tetos opcionais do dono (conta/bot), `MAX_STEPS_SAFETY`, estagnação, repetição, falhas e o botão de parar. Sem teto em US$ o custo só é limitado pelo número de passos (200 × modelo).
- **Laço:** sem tempo, a garantia de término é: passos de segurança, aborto por repetição ou resposta do modelo. Testado para chat e trabalho longo.
- **Timer de prazo:** `deadlineAtMs` passa a ser `undefined` sem teto (nunca `Infinity`, que dispararia na hora); `wallClockAnchors` e o motor novo foram ajustados e testados.
- **Lock da fila (BullMQ):** o lock do job é renovado por `job.extendLock` enquanto o worker vive (`AGENT_RUN_LOCK_MS = 120 s`), então um run longo não é considerado parado; nada precisou mudar. Revisar se a renovação falhar em produção.
- **Falso positivo do portão "vou fazer X":** texto curto de 1ª pessoa no futuro, sem "?", depois de trabalho iniciado, volta uma vez ao modelo (custa uma chamada). Promessa de avisar/lembrar não é barrada.
- **Promoção por verbo de ação / 1ª tool de navegador:** mais chats viram trabalho longo (lista de tarefas e caderno); pedidos muito curtos com um verbo solto continuam chat.
