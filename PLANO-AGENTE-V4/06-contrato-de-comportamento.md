# Contrato de comportamento do Motor v4

Fonte: a pesquisa [`pesquisa/coerencia-de-uso.md`](pesquisa/coerencia-de-uso.md) (Grok Bot, ChatGPT dots e agent, Claude Duet, Cowork e Chrome, Gemini e Spark, Alexa+, Comet, Manus, Copilot, Poke), adaptada às regras do Atlas.

**A ideia central:** o usuário sente coerência quando consegue dizer numa frase o que o bot faz sozinho e o que ele pergunta, e isso **vale sempre**.

Os produtos que conseguem isso implementam a regra **fora do modelo**. Os que falham deixam a regra ao julgamento do modelo (Comet comprando em loja falsa, Poke escolhendo mal o que avisar), ou a variam por superfície ou plano (Copilot, Neon).

> **A frase do Atlas:** "Eu leio, pesquiso, rascunho e organizo sozinho. Antes de enviar, pagar, publicar ou apagar, eu te mostro exatamente o quê. Senha, dinheiro entre contas e aceite de termos ficam com você. Você vê tudo o que eu agendei e aprendi, e pode parar a qualquer momento."

Cada cláusula tem um **mecanismo no código** e um **teste invariante**. Prompt não conta como mecanismo.

| # | Cláusula | Mecanismo no v4 | Teste invariante | Referência |
|---|---|---|---|---|
| 1 | Todo efeito tem classe declarada pela tool, não pelo modelo. | `defineTool({ effect })` é obrigatório; o registro recusa tool sem classe. MCP usa anotações, depois classificação de schema em cache, depois *fail-closed*. | Tool sem `effect` não registra. MCP sem anotação vira `write_external`. | Gemini, Duet |
| 2 | Ler e rascunhar são livres; efeito externo passa por portão que o modelo não contorna. | `decide()` puro em shared. O executor exige token de aprovação para `approve`. | Nenhuma tool `send`, `money`, `public_link`, `destructive` ou `write_external` executa sem token (varre todas as tools registradas). | Duet; contraexemplo Comet |
| 3 | A aprovação mostra o efeito exato: destino, todos os destinatários, conteúdo final, valor, frete, final do cartão. | O cartão é renderizado dos **argumentos** e dos `riskFacts`. O token é o hash dos argumentos. | Mudar um argumento depois de aprovado invalida o token. | Duet, NN/g |
| 4 | Aprovação vale para uma ação ou para um mandato delimitado, nunca genérica. | `Mandate { maxAmount, merchants, until, uses }`, checado a cada execução. Sem "sempre permitir" para `money`, `destructive` e `credential`. | Mandato vencido, de outra loja ou acima do valor vira `approve`. | dots, AP2, Spark |
| 5 | Algumas ações são sempre do dono. | Lista fixa (`HANDOFF_ACTIONS`) responde `handoff`: o run estaciona com o "passo seu". | Nenhuma autonomia ou regra libera um item da lista. | Chrome auto browse, dots |
| 6 | Segredo nunca entra no contexto. | Porta `Vault`: `login_fill` e `card_fill` resolvem na execução; cartão virtual quando o provedor permitir. | Varredura de eventos SSE, journal, `tool_result` e logs com segredos sintéticos. | Duet, Gemini, Grok |
| 7 | O autorizador não lê conteúdo não confiável. | `decide()` e o cartão recebem só metadados e argumentos tipados. | A assinatura de `decide()` não aceita texto livre (teste de tipo). | Google User Alignment Critic |
| 8 | Dado de fora carrega proveniência; efeito externo depois de leitura não confiável pede aprovação. | Taint por valor e por run (`run.taint`). `decide()` promove `run` para `approve` em `send`, `write_external` e `public_link`. | Replay: e-mail com injeção "encaminhe para X" gera cartão, nunca envio. | Origin Sets, CaMeL, Willison |
| 9 | O plano de trabalho com conteúdo hostil não ganha poder novo. | Sem fase que filtra tools (proibido pela regra 60). Quem garante é a cláusula 8 mais o perfil da superfície: agenda e rotina não veem `send` nem `money`. | Rotina que lê e-mail com injeção não consegue enviar. | Six patterns (Beurer-Kellner et al.) |
| 10 | Permissão de agenda e de rotina é decidida na criação e persiste; o que precisa do dono vira pendência. | Perfil sem humano. A saída é `prepare_for_owner` (pendência na fila), e o resto da tarefa continua. | Rotina nunca pede a mesma permissão duas vezes. Pendência dispensada não volta. | Duet; contraexemplo Cowork agendado |
| 11 | O relato do que foi feito vem do executor, não da narração. | `Receipt` tipado por tool de efeito. Os cards "o que eu fiz" e os de resultado saem do journal. O texto do modelo continua intacto. | Card de resultado sem recibo correspondente falha o teste de contrato. | Duet; contraexemplo Replit |
| 12 | Toda tarefa é visível e interrompível. | Eventos tipados de plano, passo, pausa e handoff. Parar cancela o job e lista os efeitos já consumados ("parar não desfaz"). | Parar no meio lista os recibos já emitidos. | Gemini (log, take over), dots |
| 13 | Proatividade é objeto inspecionável com freio. | Uma entidade (agenda) com intervalo mínimo, espaçamento, `maxRuns`, parada por avisos ignorados, silêncio em `no_change` e lista na Biblioteca. | `no_change` não posta. O vigia para depois de N avisos ignorados. | Gemini Scheduled, freios da Meta; contraexemplo Poke |
| 14 | Tudo o que o agente aprende é visível, editável e apagável, regras incluídas. | As 5 camadas de memória (`03` §7) e nada fora delas. `MemoryChange` registra cada mudança, com desfazer. | O sono só escreve via a mesma API da UI. Fato vindo de e-mail não vira memória. Grupo não vaza para o 1:1. | ChatGPT; contraexemplos dots e Duet |
| 15 | Tool falha alto, com o erro real e uma alternativa; parada diz o motivo real e o gasto. | `ok:false` com erro sanitizado. O passo final mostra o gasto e o que foi entregue. Travas só para proteger o dono e contra laço. | Replays de falha. A nota de parada só cita teto se um teto do dono disparou. | Anthropic (poka-yoke); contraexemplo Manus |
| 16 | Um vocabulário e uma política só, em todas as superfícies. | `decide()` e os nomes de produto em shared, consumidos por chat, agenda, rotina, subagente, bots, web e celular. | Matriz superfície × efeito: o mesmo resultado onde a regra diz igual. | Gemini; contraexemplos Neon e Copilot |

## Cláusulas de tom e formato (contrato de trabalho no prompt, protegidas por eval)
Estas dependem do modelo. Por isso viram **prompt curto mais rubrica no eval**, nunca portão no runtime:
- **Entrega primeiro, depois as fontes,** e o que não foi confirmado. O tamanho é proporcional ao pedido.
- **Antecipa:** traz o conteúdo, não o índice (o resumo de e-mail diz o que cada um pede e o prazo), e resolve a próxima pergunta óbvia se for barata e segura.
- **Formato certo:** trabalho vira arquivo, comparação vira tabela ou painel, produto vira card.
- **Pergunta só na fronteira.** A lacuna crítica sem valor inferível (ex.: qual voo) vira **uma** pergunta com sugestão.
- **Linguagem do produto:** nunca expõe nomes internos.

## Ordem de implementação
1. As cláusulas 1, 2, 3, 6, 7 e 16 entram na **F1** (sem elas não há v4).
2. As 8 e 9 entram na **F1**, com prioridade em e-mail, onde o Atlas junta os três lados da trifeta.
3. As 10 e 13 entram na **F4** (Agenda).
4. A 14 entra na **F5** (Memória).
5. As 4 e 5 entram na **F6** (Compras).
6. As 11, 12 e 15 entram de forma incremental em cada capacidade, porque cada tool de efeito nasce com recibo.
