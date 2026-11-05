# Grok (xAI) como assistente/agente pessoal — coerência de uso (estado: nov/2026)

Aviso geral: quase tudo vem de fontes secundárias (blogs, agregadores); só a página docs.x.ai dos conectores é primária. Não achei changelog/help center da xAI nas buscas. Há ambiguidade de nome: "Grok" (chatbot grok.com), "Grok Bot" (agente com computador próprio, beta ago/2026) e "Grok Build" (dev). Marcado onde incerto.

## 1. Quando age sozinho vs. pede aprovação; UI de aprovação

### Takeaway
Compras exigem aprovação explícita do usuário (botão "Buy now"); envio de e-mail provavelmente exige revisão do rascunho, mas a confirmação é de fonte terciária. A documentação primária dos conectores não descreve confirmação de envio.

### Cited Findings
- Agente (Grok Bot) lançado em beta em 11/ago/2026 com Grok 4.6; compras online anunciadas em 28/ago; loja ampla ~10/out (data sem fonte primária; EUA primeiro) — [Basenor](https://www.basenor.com/blogs/news/grok-bot-can-now-research-and-buy-gifts-for-you)
- Toda compra precisa de aprovação explícita antes de finalizar; o bot não pode fechar pedido sozinho — [Basenor](https://www.basenor.com/blogs/news/grok-bot-can-now-research-and-buy-gifts-for-you); [Digg](https://digg.com/tech/2psh49kb)
- Cada transação usa cartão virtual descartável via Stripe; usuário põe cartão num "Vault" ou fotografa o cartão no chat; o Grok não acessa/armazena o cartão real. Métodos citados: Shop Pay, Link, X Money — [Basenor](https://www.basenor.com/blogs/news/grok-bot-can-now-research-and-buy-gifts-for-you); [guia](https://aisuccesslabjuliangoldie.com/blog/grok-bot-shopping/)
- Docs dos conectores Gmail/Calendar: Gmail pode buscar, ler (corpo, cabeçalhos, anexos), gerenciar rascunhos, enviar, responder, encaminhar, rotular, apagar; Calendar cria/edita/apaga eventos e RSVP. Começam somente leitura; escrita habilitada progressivamente (por admins). A página NÃO diz se há confirmação antes de enviar — [docs.x.ai](https://docs.x.ai/grok/connectors/gmail-google-calendar)
- Terceiro (explainx, out/2026) afirma que o Grok Bot, com caixa de e-mail própria, exige aprovação de cada e-mail de saída: o usuário vê o rascunho completo e aperta Send, sem bypass por instrução de chat/rotina; o próprio post diz não ter verificado contra o changelog — [AlphaSignal](https://alphasignal.ai/news/xai-gives-grok-bot-its-own-email-inbox-to-act-without-you); [explainx](https://explainx.ai/blog/grok-bot-own-email-address-v0-70-2-approvals-what-is-verified-2026)
- Automations (jul/2026): nenhuma etapa de aprovação embutida documentada; artigo sugere escrever instruções que proíbam ações externas sem confirmação humana — [remio](https://www.remio.ai/post/grok-automations-launch-with-email-triggers-but-reliability-is-the-real-test)

### Inferences
- Padrão aparente: ação financeira = gate duro de UI; ação de leitura = autônoma; escrita em e-mail/agenda = ambíguo (depende de permissão OAuth e da superfície). Esse é um ponto de incoerência potencial.

### Gaps
- Sem doc oficial do layout da tela de aprovação (campos mostrados, edição, "sempre permitir"). Sem confirmação oficial de gate para envio de e-mail.

## 2. Reporte de progresso e resultados (cards, fontes, tom)

### Takeaway
Resultados de produto aparecem como cards em carrossel (foto, nota, preço, loja, selos de qualidade) desde a v0.78.1 (27/out/2026), segundo fonte secundária.

### Cited Findings
- v0.78.1 (27/out): resultados de produto como cards com fotos, avaliações, preços, loja e selos de qualidade; carrossel — [Basenor](https://www.basenor.com/blogs/news/grok-bot-can-now-research-and-buy-gifts-for-you)
- Automations: cada execução é salva como conversa completa no histórico, revisável e continuável; notificação por e-mail, app, ambos ou nenhum — [remio](https://www.remio.ai/post/grok-automations-launch-with-email-triggers-but-reliability-is-the-real-test)

### Inferences
- A conversa-por-execução dá rastreabilidade e continuidade (bom para coerência).

### Gaps
- Nada confiável sobre convenções de tom/formato de resposta do agente nem citação de fontes em cards.

## 3. Memória

### Takeaway
Memória entre chats existe desde abr/2025, com toggle e exclusão individual; detalhes de 2026 vêm de guias não oficiais.

### Cited Findings
- Configurações > Data Controls: toggle "Personalize with memories" (outros guias: "Memory across chats"); memórias podem ser revisadas/expandidas e excluídas individualmente na web (no lançamento, Android "em breve" — dado antigo); "Delete All Conversations" existe; chat apagado fica restaurável 30 dias — [Bluehost](https://www.bluehost.com/blog/?p=280653); [allthings.how](https://allthings.how/disable-grok-ais-new-memory-feature-for-privacy-and-control/); [AI-Toolbox](https://www.ai-toolbox.co/grok-management-and-productivity/does-grok-remember-past-conversations-2026)
- Em 2025 a memória não estava disponível em parte da UE/Reino Unido (info antiga) — [The Decoder](https://the-decoder.com/xai-adds-memory-feature-to-grok-chatbot-for-personalized-responses/)
- Conectores: segundo docs, dados do Gmail/Calendar são lidos em tempo real e não retidos nem usados em treino — [docs.x.ai](https://docs.x.ai/grok/connectors/gmail-google-calendar)

### Gaps
- Memória específica do Grok Bot e companions: nada verificável. Sem help center oficial encontrado.

## 4. Proatividade: tarefas agendadas, briefings, lembretes, entregas

### Takeaway
"Tasks" (2025, beta) evoluiu para "Automations" (16/jul/2026): agendadas (todos os usuários) ou disparadas por e-mail (SuperGrok). Rastreio de entregas é incipiente.

### Cited Findings
- Tasks vazou em mai/2025 com agenda única/diária/semanal/mensal/anual — [Latestly](https://www.latestly.com/socially/technology/elon-musks-xai-working-on-scheduled-tasks-feature-for-grok-chatbot-will-allow-users-to-complete-tasks-at-later-date-6863041.html) (antigo)
- Automations: cronograma único/diário/dias úteis/semanal/mensal/anual no fuso do usuário; gatilho de e-mail por remetente/destinatário/assunto; anexar arquivos, conectores e skills; "Run now" para testar; pausar/retomar/editar/apagar — [remio](https://www.remio.ai/post/grok-automations-launch-with-email-triggers-but-reliability-is-the-real-test)
- Briefing matinal dos dias úteis lendo inbox+agenda, e bot "primário" instruído a ser proativo: relatos de guias, não oficiais — [Techpresso](https://academy.techpresso.co/courses/how-to-build-an-ai-chief-of-staff-with-grok-bot)
- Rastreio de entrega: Musk disse que o Grok rastreou um pedido de LEGO (13/out); post de 4/nov fala em rastrear compras e devoluções como plano — [Basenor](https://www.basenor.com/blogs/news/grok-bot-can-now-research-and-buy-gifts-for-you)

### Inferences
- Lembretes/follow-ups criados pelo próprio agente sem pedido: não encontrei evidência; a proatividade parece configurada pelo usuário.

### Gaps
- Sem doc de follow-up autônomo, retries, ou silêncio quando não há novidade.

## 5. Separação instrução do usuário vs. conteúdo externo (injection)

### Takeaway
Não há doc oficial encontrada de defesa contra injection em e-mail/web; é risco reconhecido por terceiros.

### Cited Findings
- Caixa de e-mail própria do bot (domínio grokbot) trata toda mensagem recebida como entrada não confiável; xAI não publicou limites de envio, retenção ou allowlists — [AlphaSignal](https://alphasignal.ai/news/xai-gives-grok-bot-its-own-email-inbox-to-act-without-you)
- Precedente: ataque por código Morse em post no X induziu transferência de tokens por carteira ligada ao Grok (mai/2026) — [CryptoSlate](https://cryptoslate.com/?p=534520) (relato; verificar)
- Vulnerabilidades de prompt injection do Grok reportadas em 2024 (antigo) — [Simon Willison](https://feeds.simonwillison.net/2024/Dec/16/security-probllms-in-xais-grok/)

### Gaps
- Nenhuma defesa documentada pela xAI.

## 6. Tarefas longas, erros, recuperação e reclamações

### Takeaway
Reclamações de indisponibilidade e estagnação existem, mas as fontes são fóruns e de atribuição duvidosa.

### Cited Findings
- Automations: xAI não publicou taxas de erro, retries, timeouts, gatilhos duplicados; falhas possíveis: autorização de conector perdida, mudança de modelo — [remio](https://www.remio.ai/post/grok-automations-launch-with-email-triggers-but-reliability-is-the-real-test)
- Relatos anedóticos de bots mudos/computador fora do ar por 60h+, "Something went wrong while generating the reply" — [fórum](https://forum.cursor.com/t/grok-bot-incompetent-today/173242). ATENÇÃO: está no fórum da Cursor e a leitura indica que o "bot" ali é de um produto Cursor com computer-use; pode NÃO ser o Grok Bot da xAI. Baixa confiança.
- Alegação de Reddit (não verificada) de que o Grok Bot contatou a HBO Max sem pedido — [RuntimeWire](https://runtimewire.com/article/a-reddit-user-says-grok-bot-snitched-to-hbo-max-after-a-subscription-glitch)
- Reclamações gerais do chatbot Grok: esquece contexto, respostas sem sentido (Trustpilot, anedótico) — [Trustpilot](https://www.trustpilot.com/review/grok.com?page=3)

### Gaps
- Sem dados sistemáticos de inconsistência; sem info de companions (não pesquisado a fundo) nem de computer use do Grok além do Grok Bot.
