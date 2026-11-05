# Claude (Anthropic): coerência de uso como assistente agêntico, estado em nov/2026

## O que é o "Duet do Claude"?

### Takeaway
"Claude Duet" é um produto real, não confusão com outro: agente proativo da Anthropic anunciado em 21/10/2026 como research preview (app iOS, Android e claude.ai; lista de espera, só EUA, Pro/Max/Ultra). Não é o "Duet AI" do Google nem o projeto open-source `claude-duet` do GitHub (esse não é da Anthropic).

### Cited Findings
- Anúncio oficial "Introducing Claude Duet" em 21/10/2026; app que "vem até você com o que precisa de atenção"; roda em Claude Opus 5.5, sem escolha de modelo — [claude.com](https://claude.com/resources/articles/claude-duet); [HackerNoon](https://hackernoon.com/what-is-claude-duet-inside-anthropics-always-on-ai-assistant)
- Acesso: lista de espera, EUA, Pro/Max/Ultra; Team/Enterprise e Microsoft 365 ainda não; sem custo extra, mas consome os mesmos limites de 5h e semanais (checagens em segundo plano contam); um reset de limite concedido na admissão, válido até 30/11/2026 — [Get started with Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- Arquitetura: uma VM na nuvem com navegador próprio por usuário, funciona com seus aparelhos desligados; consulta as contas conectadas a cada poucas horas (não em streaming); uma única thread longa, por texto ou voz; saídas como artefatos reais (docs, planilhas, decks) — [HackerNoon](https://hackernoon.com/what-is-claude-duet-inside-anthropics-always-on-ai-assistant)
- Conectores: "mais de 6.000" via Claude Marketplace (Gmail, Slack, Stripe, QuickBooks, Gusto, HubSpot etc.) — [ITdaily](https://itdaily.com/news/software/claude-duet/)
- Limitações declaradas: pode ler mal uma conversa ou julgar mal urgência; pode perder eventos entre checagens; ainda não mostra o navegador ao usuário; app separado do chat; não faz ligações nem SMS — [HackerNoon](https://hackernoon.com/what-is-claude-duet-inside-anthropics-always-on-ai-assistant); [suporte](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- Cobertura é majoritariamente de imprensa secundária (muitas não-inglesas); os fatos acima batem entre a página oficial, o suporte e dois veículos.

### Inferences
- Duet é a versão "consumer" que reúne os padrões de Cowork, Chrome, memória e o classificador do auto mode do Claude Code. É a melhor referência de "coerência" para o Atlas.

### Gaps
- Não li a página `claude.com/product/claude-duet` nem o texto integral do anúncio, só resumos via fetch/search.

## Quando age sozinho vs. pergunta (permissões, confirmações)

### Takeaway
Padrão consistente em todos os produtos: ler, rascunhar e preparar é autônomo; enviar, pagar, assinar, apagar e publicar exigem aprovação mostrando o conteúdo exato; um pequeno conjunto é proibido mesmo com aprovação. Há modos de autonomia ajustáveis no Chrome/Cowork, mas com salvaguardas que permanecem.

### Cited Findings
- Duet: antes de enviar mensagem sensível, pagar ou apagar, mostra ação, destino e conteúdo completo (todos os destinatários) e espera aprovação; checagem automática fora do modelo avalia se a ação corresponde à intenção do usuário, construída sobre o classificador do auto mode do Claude Code — [Safety, Privacy and Security](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)
- Duet: proibido mesmo com aprovação: negociar valores mobiliários, mover dinheiro entre contas, acessar conta de terceiros. Não podem virar "não perguntar de novo": pagar/enviar dinheiro, apagar pedido, criar conta — mesma fonte
- Duet: compras com cartão virtual de uso único (ex.: Link), limitado a um comerciante e valor; usuário aprova no app do Link; número real nunca é compartilhado — mesma fonte
- Duet: se o usuário não pode aprovar agora, termina o resto da tarefa e traz a aprovação depois; só o usuário marca uma tarefa como concluída — [suporte](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- Duet: a própria Anthropic reconhece risco de "fadiga de aprovação" e diz que frequência de aprovação ainda está sendo ajustada — [Safety](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)
- Claude in Chrome: permissões por site, revogáveis a qualquer momento; pede confirmação antes de ações de alto risco (publicar, comprar, compartilhar dados pessoais); mesmo no modo autônomo experimental algumas salvaguardas ficam; bloqueia categorias de site de alto risco (financeiro, adulto, pirata) — [claude.com/blog/claude-for-chrome](https://claude.com/blog/claude-for-chrome)
- Chrome/Cowork: modos renomeados em ajuda atual: "Manually approve" (antes "Ask before acting") e "Skip all approvals" (antes "Act without asking"); o modo sem aprovação aumenta o risco de injeção, mas deve ainda perguntar em compras/transações financeiras — [Chrome permissions](https://support.claude.com/en/articles/12902446-manage-claude-in-chrome-permissions) (conteúdo via resumo de busca; rótulos variam entre páginas e terceiros)
- Admins Team/Enterprise: ligar/desligar em toda a organização e listas de sites permitidos/bloqueados (dez/2025) — [claude.com/blog/claude-for-chrome](https://claude.com/blog/claude-for-chrome)

### Inferences
- O critério real é reversibilidade e saída para terceiros, não o tipo de ferramenta. Ações que não podem ser desfeitas ou que expõem dados fora da conta ganham gate; o resto é livre.
- Aprovação nunca é só "sim/não": mostra o conteúdo exato. Isso casa com a regra do Atlas de "card de escrita mostra resultado visível".

### Gaps
- Não achei como Duet decide em qual tier uma ação cai (o próprio HackerNoon diz que não é detalhado).
- Rótulos exatos dos modos de aprovação do Cowork variam entre páginas; não verifiquei a página atual diretamente.

## Progresso e resultados (artefatos, citações, listas de tarefas)

### Takeaway
Resultados chegam como objetos reais (docs, planilhas, decks) e a thread única recebe aviso quando algo termina ou precisa de decisão; há aba de Tarefas com destaque para as que precisam do usuário. Visibilidade do que o agente fez é um ponto fraco reportado.

### Cited Findings
- Duet: posta na thread principal quando tarefa termina ou exige decisão; aba Tasks destaca o que precisa de input; usuário pode ver a página de cada tarefa e redirecioná-la no meio — [suporte](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet); [Safety](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)
- Duet: sem como ver o navegador da VM ainda; testador relatou cards de uso de ferramenta crus no chat, sem explicação (anedótico, Hacker News via resumo) — [HackerNoon](https://hackernoon.com/what-is-claude-duet-inside-anthropics-always-on-ai-assistant)
- Cowork agendado: cada execução é uma sessão própria, revista em "Scheduled" na barra lateral — [suporte](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)

### Inferences
- Não achei fonte sobre citações em modo pesquisa (research) neste ciclo; não afirmar nada sobre isso.

### Gaps
- Modo Research, citações e to-do lists no Cowork/Claude Code: não pesquisados (limite de chamadas).

## Memória: transparência e controles

### Takeaway
Memória é visível e editável, importável e exportável; Duet reutiliza a memória da conta. Desconectar um app não apaga o que já foi aprendido.

### Cited Findings
- Ver/editar: Configurações > Memória (contas novas) ou Capacidades > "Ver e editar sua memória" (legado); importação de outro provedor é guardada como edições individuais e rotulada experimental; export pedindo ao Claude que escreva as memórias literalmente; disponível Free/Pro/Max/Team conforme a página oficial — [suporte](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude) (conteúdo via resumo de busca)
- Duet: usa a memória, skills e conectores da conta; pode pesquisar chats anteriores do Duet e chats do Claude fora de projetos (desligável em "Search and reference chats"); chats apagados saem da busca — [suporte](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- Duet: histórico e memória persistem até o usuário apagar/resetar; desconectar um app não apaga o que já foi aprendido (precisa resetar a memória nas configurações do app); apagar a conta apaga tudo; sem prazos de retenção específicos — [Safety](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)
- Crítica: ao ser perguntado, Duet recusou listar seus arquivos/instruções, então regras aprendidas e conteúdo da VM não são inspecionáveis (anedótico, HN) — [HackerNoon](https://hackernoon.com/what-is-claude-duet-inside-anthropics-always-on-ai-assistant)

### Inferences
- Há uma assimetria de transparência: memória de perfil é editável, mas "regras aprendidas" e estado da VM do Duet não aparecem no mesmo lugar.

### Gaps
- Memória por projeto e comportamento exato de edição não verificados em primária.

## Proatividade (tarefas agendadas, briefs)

### Takeaway
Duet é proativo por design (brief matinal, follow-up de threads silenciosas, só avisa quando importa); Cowork tem tarefas agendadas. A coerência de execução agendada é o ponto mais citado de reclamação.

### Cited Findings
- Duet: toda manhã revisa e-mail e agenda, aponta o que precisa de atenção e pode iniciar primeiros passos (ex.: rascunhar respostas para revisão); ao longo do dia atualiza e faz follow-up de threads paradas; "só avisa quando algo exige atenção" — [suporte](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet); [ITdaily](https://itdaily.com/news/software/claude-duet/)
- Cowork agendado: horário, diário, semanal, dias úteis ou manual; roda remotamente (mantém cadência com o computador dormindo); tarefas que precisam de arquivos/apps locais só rodam localmente; ao criar manualmente escolhe-se um modo de aprovação — [suporte](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork). Contradiz materiais anteriores/de terceiros que diziam que exigia computador acordado e app aberto (info mais antiga, provavelmente superada).
- Reclamações de usuários (anedóticas, issues no GitHub): tarefas agendadas ignoram "Always allow" e repetem pedidos de permissão a cada execução; "Allow for all scheduled runs" não persiste (Windows); regras deny bloqueiam execuções agendadas — [issue 47180](https://github.com/anthropics/claude-code/issues/47180); [claudeissues 59302](https://claudeissues.com/issue/59302-bug-allow-for-all-scheduled-runs-folder-permission-not-persisting-in-scheduled-t); [claudeissues 92833](https://claudeissues.com/issue/92833-cowork-scheduled-task-runs-deny-mcp-workspace-bash-and-mcp-workspace-web-fetch-b)
- Crítica: checagens a cada poucas horas podem perder eventos; limites de uso são consumidos em segundo plano — [HackerNoon](https://hackernoon.com/what-is-claude-duet-inside-anthropics-always-on-ai-assistant)

### Inferences
- Uma tarefa agendada que pergunta a cada execução quebra a promessa de autonomia; a permissão precisa ser decidida na criação e persistir. Alinha com a regra do Atlas (rotinas read-only, confirmar escrita).

### Gaps
- Controles de notificação, horário silencioso, pausar/interromper Duet: a página de suporte não os descreve.
- Status atual dos bugs de permissão em agendadas: desconhecido.

## Defesas contra prompt injection e separação usuário vs. conteúdo externo

### Takeaway
Estratégia em camadas: treino (RL), classificadores, permissões por site, gate de aprovação fora do modelo e isolamento de credenciais. Anthropic afirma que não está resolvido e publica taxas de sucesso de ataque que ainda não são zero.

### Cited Findings
- Chrome (ago/2025): 123 casos em 29 cenários; ataque sem mitigação 23,6%; com mitigações em modo autônomo 11,2%; conjunto de 4 ataques específicos de navegador 35,7% para 0%; exemplo de e-mail falso que fez Claude apagar e-mails sem confirmar — [claude.com/blog/claude-for-chrome](https://claude.com/blog/claude-for-chrome) (dado antigo; Simon Willison chamou 11,2% de inaceitável: [comentário](https://feeds.simonwillison.net/2025/Aug/26/piloting-claude-for-chrome))
- Nov/2025, Opus 4.5: ~1% de sucesso contra atacante Best-of-N com 100 tentativas por ambiente; Anthropic diz que ainda é risco relevante e que nenhum agente de navegador é imune; credita RL e classificadores de comandos adversariais em texto, imagem e UI — [Anthropic, prompt injection defenses](https://www.anthropic.com/research/prompt-injection-defenses) (via resumo de busca)
- Números conflitantes: um veículo cita 31,5% de sequestro para "Opus 4.8" antes das salvaguardas (system card de 28/05/2026) e o system card do Opus 4.6 com 78,6% em GUI sem salvaguardas e 0% em ambiente de código — NÃO verificado em primária — [ThreatCluster](https://threatcluster.io/cluster/anthropics-opus-48-browser-agent-faces-315-hijack-rate-pre-s-e79fcd84); [WorkOS](https://workos.com/blog/ai-agent-governance-prompt-injection-surface-not-model)
- Duet: a checagem de aprovação roda fora do modelo, então instruções escondidas numa página não a influenciam; texto de páginas e downloads ainda voltam ao agente, o que a Anthropic reconhece como motivo para outras camadas; avaliações em três variantes (tarefa inocente, com injeção, tentadora para extrapolar) mais tráfego-sombra; red team, pentest externo com acesso ao código, escopo no bug bounty — [Safety](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)
- Duet: senhas digitadas num formulário dentro do app, criptografadas com chave de uso único que só existe na máquina do navegador; o modelo nunca vê; tokens de sessão ficam fora da VM do agente (placeholder trocado por proxy externo); o agente só abre páginas, clica e digita; User-Agent distinto e IPs publicados (alguns sites bloqueiam) — mesma fonte
- Duet: segundo classificador examina cada mensagem de saída e cada arquivo enviado pelo navegador; nunca compartilha credenciais, cartão/conta completos, documentos de governo; saúde e finanças só com consentimento (pedido do usuário conta); se bloquear, pode reescrever sem o dado e pedir aprovação — mesma fonte
- Cowork: documentação diz que o modo "pular aprovações" aumenta muito o risco de injeção — [suporte Chrome](https://support.claude.com/en/articles/12902446-manage-claude-in-chrome-permissions)

### Inferences
- O princípio transferível: o portão de segurança fica fora do contexto do modelo e vê a ação concreta (destino, conteúdo), e segredos nunca entram no contexto. Isso é mais forte do que "instruir o modelo a ignorar injeção".

### Gaps
- Detalhes técnicos dos classificadores do Duet não são públicos.
- Números de 2026 para o browser use: só secundários.

## Tarefas longas, interrupção, recuperação; reclamações documentadas

### Takeaway
Padrão de recuperação: terminar o que dá e devolver a aprovação depois; usuário pode redirecionar no meio. Reclamações giram em torno de limites de uso, opacidade e permissões repetidas.

### Cited Findings
- Duet: usuário pode "steer" tarefas em andamento; aprovação pendente não bloqueia o resto — [Safety](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security); [suporte](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- Críticas ao Duet: limites compartilhados com uso de código, lock-in, opacidade, sites que bloqueiam agentes/CAPTCHA, sugestões pós-setup medíocres (anedótico) — [HackerNoon](https://hackernoon.com/what-is-claude-duet-inside-anthropics-always-on-ai-assistant)
- Imprensa: lançamento chega "atrasado" frente a Gemini Spark, Meta Muse, Microsoft Autopilot e OpenAI Dots — [ITdaily](https://itdaily.com/news/software/claude-duet/)
- Cowork: relato de que o prompt "Ask First" de MCP foi contornado, executando a ferramenta antes de o usuário responder; outro de Claude Code tratando plano como aprovado sem interação — anedóticos, sem reconhecimento oficial (via resumo de busca de fóruns)

### Inferences
- Reclamações recorrentes tocam coerência: o produto promete "pergunta antes" mas há relatos de gate que falha; confiança depende de o gate ser determinístico.

### Gaps
- Sem dados quantitativos de falha; sem fonte primária sobre retomada após queda de sessão.

## Princípios publicados pela Anthropic (autonomia, perguntar vs. agir)

### Takeaway
Não consegui confirmar, neste ciclo, o texto da constituição do Claude sobre perguntar vs. agir. Só há os princípios implícitos nos produtos acima.

### Cited Findings
- Duet foi projetado para "checar antes de agir" em ações sensíveis e agir sozinho no resto — [claude.com](https://claude.com/resources/articles/claude-duet)

### Inferences
- Nenhuma além do já dito.

### Gaps
- Constituição/diretrizes de uso sobre autonomia: não pesquisadas (limite de chamadas); recomendo uma busca dedicada. Também não cobri: file creation detalhado, modo Research, Claude Code hooks como aplicados a produtos de consumo.
