# ChatGPT (OpenAI) — coerência de uso agêntico (estado em nov/2026)

Nota de método: ~12 chamadas de busca/fetch. help.openai.com, nordvpn e o system card deram 403 ou não foram alcançados; quase tudo vem de fontes secundárias. Itens não confirmados em fonte primária estão marcados [NÃO VERIFICADO].

## O que são "dots do GPT"?

### Takeaway
"dots" (minúsculo, "ChatGPT dots") é um produto real da OpenAI: agentes sempre ativos dentro do ChatGPT, anunciados no DevDay de 29/09/2026, que trabalham entre conversas num computador em nuvem próprio. Acesso restrito (Pro/Business Premium/Enterprise, fora de EEE/UK/Suíça para Pro).

### Cited Findings
- Dots anunciados no DevDay em 29/09/2026; "agentes sempre ativos que assumem trabalho contínuo e progridem entre conversas"; cada um com computador em nuvem, navegador e acesso a 4.000+ apps; uma fonte diz que rodam em "GPT-6 Astra" [NÃO VERIFICADO, sem fonte primária] — [busca agregada](https://aiweekly.co/alerts/openai-unveils-dots-always-on-chatgpt-agents-at-devday), [Tom's Guide](https://www.tomsguide.com/ai/openai-just-launched-dots-heres-why-most-chatgpt-users-cant-try-them-yet), [BetaNews](https://betanews.com/article/openai-dots-agents-chatgpt/)
- Acesso: Free/Go/Plus fora no lançamento; Pro no EEE, UK e Suíça excluídos; Enterprise desligado por padrão; criação só no desktop; fontes divergem sobre quais planos incluem o primeiro dot — [Flavio Copes (resumo de documentação)](https://flaviocopes.com/openai-dots/)
- Falam-se com o dot no ChatGPT, Slack e Teams (via CNBC citado por agregador) — [aiweekly](https://aiweekly.co/alerts/openai-unveils-dots-always-on-chatgpt-agents-at-devday)
- Dots ainda não ligam por telefone (ligações "planejadas para depois") — [Flavio Copes](https://flaviocopes.com/openai-dots/); manchetes de imprensa dizem "calls and writes for you", o que conflita — [Pasquale Pillitteri](https://pasqualepillitteri.it/en/news/19302/openai-dots-personal-ai-agent-devday-2026)

### Inferences
- Para o Atlas, dots é o análogo mais próximo de "bot autônomo persistente"; Pulse/Tasks/agent são camadas anteriores que a OpenAI parece estar consolidando.

### Gaps
- Não li o anúncio oficial da OpenAI nem a help page de dots; preço pós-1º mês não publicado.

## Quando age sozinho vs. pergunta (confirmações, takeover, watch mode, Auto-review)

### Takeaway
Padrão consistente: ações de baixo risco e leitura rodam sozinhas; ações consequentes (enviar, comprar, apagar) exigem aprovação; ações críticas (senha, transferir dinheiro) sempre vão ao usuário. Em dots há "Custom Rules" em 4 níveis e "Auto-review" que classifica cada ação em: roda / pede aprovação / passo seu.

### Cited Findings
- Dots: ações que sempre vão ao usuário = trocar senha e transferir dinheiro; apagar dados/instalar software pode exigir aprovação a cada vez; compras exigem aprovação, antecipável só se cobrir aquela compra específica — [Flavio Copes](https://flaviocopes.com/openai-dots/)
- Dots: Auto-review checa ação contra instruções, permissões, Custom Rules e requisitos de segurança → executa, pede aprovação ou vira passo do usuário; Custom Rules: agir sem perguntar / agir quando eu disser / perguntar antes / passar para mim; regras não sobrepõem segurança embutida — [Flavio Copes](https://flaviocopes.com/openai-dots/)
- Dots: ferramentas de "pesquisa proativa" leem apps conectados mas não enviam, editam nem controlam navegador; qualquer ação de seguimento passa por aprovações normais — [Flavio Copes](https://flaviocopes.com/openai-dots/)
- ChatGPT agent (jul/2025): pede consentimento antes de passos consequentes (enviar e-mail, submeter formulário); "takeover mode" = usuário digita dados sensíveis num navegador controlado por ele, sem screenshots capturadas; "watch mode" descrito de formas diferentes por fontes secundárias (pausa se o usuário fica inativo em operações sensíveis / revisão obrigatória de passos de alto impacto) — [VentureBeat](https://venturebeat.com/ai/openai-unveils-chatgpt-agent-that-gives-chatgpt-its-own-computer-to-autonomously-use-your-email-and-web-apps-download-and-create-files-for-you), [TestingCatalog](https://testingcatalog.com/openai-unveils-agent-mode-in-chatgpt-for-complex-task-handling), [Libertify resumo do system card](https://www.libertify.com/?p=33581). [system card primário NÃO lido]
- Atlas (out/2025): "logged-out mode" (agente sem cookies/login) e "watch mode" em sites sensíveis (exige aba ativa). Willison testou GitHub e banco e o watch mode aparentemente não disparou; Atlas continuou navegando ao trocar de app — [Simon Willison](https://feeds.simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)
- Model Spec (explicação oficial de mar/2026): em contextos agênticos o modelo deve preencher lacunas de instruções com autonomia, "controlando cuidadosamente efeitos colaterais no mundo real"; changelog resumido: "agir dentro de escopo de autonomia acordado" e "controlar e comunicar efeitos colaterais" — [OpenAI, Our approach to the Model Spec](https://openai.com/ga-IE/index/our-approach-to-the-model-spec/), [xenospectrum](https://xenospectrum.com/en/openai-model-spec-2026-agent-governance/)

### Inferences
- A coerência da OpenAI está num vocabulário de 3 estados (executa / aprova / entrega ao humano) aplicado por classe de risco, não por feature.
- Aprovação "antecipada só para aquela compra" evita autorização genérica de pagamento.

### Gaps
- Texto exato dos prompts de confirmação do agent/Atlas; system card de dots (se existe) não lido.
- Se o bug do watch mode no Atlas foi corrigido: nada encontrado.

## Progresso e resultados

### Takeaway
Dots: visão "Activity" no app desktop com progresso, arquivos e resultados, sinalizando pedidos esperando o usuário; pausar/retomar tarefa principal, parar tarefa delegada; parar não desfaz ações feitas.

### Cited Findings
- Activity view + Scheduled; "stopping doesn't undo completed actions" — [Flavio Copes](https://flaviocopes.com/openai-dots/)
- Instant Checkout: confirmação de pedido com check no chat e e-mail do vendedor; pedidos passados em Configurações — [Fintech News SG](https://fintechnews.sg/119473/ai/checkout-in-chatgpt/) (cobertura de lançamento, 2025)

### Gaps
- Carrosséis de produtos/citações/narração de passos do agent: não verifiquei em fonte primária.

## Memória: transparência e controles

### Takeaway
No ChatGPT: memórias salvas visíveis/editáveis/apagáveis; referência ao histórico é separada; apagar o chat não apaga a memória derivada. Dots tem memória própria NÃO inspecionável — assimetria relevante.

### Cited Findings
- Remover em Configurações > Personalização > Gerenciar memórias ou pedindo para esquecer; remoção completa exige apagar a memória e o chat de origem; desligar "Referenciar memórias salvas" desliga também "Referenciar histórico"; Chat Temporário evita memória — [OpenAI Help: memory](https://help.openai.com/en/articles/8590148-memory-and-newer-features-), [OpenAI Help: past conversations](https://help.openai.com/en/articles/10303002-how-does-memory-use-past-conversations)
- Dots: usuário não pode ver, corrigir ou apagar notas individuais; só apagar o dot inteiro; desligar Memory do ChatGPT para de compartilhar mas não apaga o que o dot recebeu; desconectar plugin mantém o aprendido — [Flavio Copes](https://flaviocopes.com/openai-dots/)
- Mudança de jun/2026 para resumo de memória sintetizado automaticamente, lista explícita virando "legacy" — só fontes de terceiros [NÃO VERIFICADO] — [memx.app](https://memx.app/blog/chatgpt-reference-chat-history-vs-saved-memories/), [unabyss](https://unabyss.com/blog/chatgpt-memory)

### Inferences
- Incoerência de transparência: memória do ChatGPT é auditável, a do dot não.

### Gaps
- Confirmar mudança de jun/2026 na help oficial.

## Proatividade: Pulse, Tasks, auto-agendamento

### Takeaway
Pulse está sendo aposentado; a proatividade migra para tarefas agendadas. Dots define o próprio tempo de retorno.

### Cited Findings
- Help oficial (via resultado de busca; fetch deu 403): "We're retiring Pulse in the next 14 days"; briefing diário passa a ser tarefa agendada baseada em interesses e chats; cards salvos viram chats comuns — [OpenAI Help: Pulse](https://help.openai.com/articles/12293630-chatgpt-pulse). Data exata da aposentadoria não confirmada.
- Pulse (2025): 5–10 cards matinais, gerados de histórico, feedback, Gmail/Calendar opt-in, exigia memória ligada — [Digit](https://www.digit.in/news/apps/openai-introduces-chatgpt-pulse-for-ai-powered-morning-briefings-how-it-works.html), [Neowin](https://www.neowin.net/news/chatgpt-now-proactively-delivers-updates-with-new-pulse-feature/)
- Dots: define o próprio follow-up (ex.: checar resposta de e-mail), agendas fixas com fuso e data final aparecem em "Scheduled"; gatilhos por evento só em alguns serviços; estar num canal do Slack não faz monitorá-lo — [Flavio Copes](https://flaviocopes.com/openai-dots/)

### Inferences
- A OpenAI recuou do feed de cards proativos (produto separado) para agendamento explícito e inspecionável.

### Gaps
- Não pesquisei Tasks (limites, notificações) em fonte primária.

## Compras: Instant Checkout / ACP

### Takeaway
Status contraditório: lançado em 2025 com Etsy/Shopify via ACP (com Stripe); uma fonte afirma remoção em 24/03/2026, com checkout voltando ao site do comerciante. Não confirmado.

### Cited Findings
- ACP aberto pela OpenAI e Stripe; agente passa SharedPaymentToken, comerciante cobra e confirma — [Idukki](https://idukki.io/blog/agentic-checkout-explained-acp-and-instant-checkout)
- Alegação de remoção em 24/03/2026 — [Godberry Studios](https://godberrystudios.com/posts/agentic-commerce-2026-chatgpt-shopify-visa-merchant-playbook/) [NÃO VERIFICADO, fonte única]; estagnação por dados de estoque/preço defasados — [Naturaily](https://naturaily.com/blog/agentic-commerce-shopify-guide)

### Gaps
- Confirmar status oficial; passos exatos de confirmação do usuário.

## Prompt injection e separação instrução/conteúdo

### Takeaway
Defesa em camadas: modos que limitam acesso (logged-out, watch, takeover), confirmações, hierarquia de instruções; OpenAI admite que não elimina o risco.

### Cited Findings
- OpenAI reconhece vulnerabilidade a instruções ocultas em web/e-mail; Willison: defesa principal parece ser o usuário vigiar — [Simon Willison](https://feeds.simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/); [HUMAN Security](https://www.humansecurity.com/ai-agent/chatgpt-atlas/); ataques por injeção (inclusive clipboard) apareceram logo após o lançamento do Atlas — [Fortune](https://fortune.com/2025/10/23/cybersecurity-vulnerabilities-openai-chatgpt-atlas-ai-browser-leak-user-data-malware-prompt-injection/)
- Dots: OpenAI reporta zero injeções bem-sucedidas em 16.600 ataques simulados e 2.638 tentativas adaptativas; violações moderadas de escopo subiram de 8,6% para 19,7% quando tarefas intermediárias foram de 5 para 10 (sem violações graves); adaptou-se a mudança de permissão em 17/17 casos explícitos — [Flavio Copes](https://flaviocopes.com/openai-dots/) (números de segunda mão, não vistos no system card)
- Model Spec: cadeia de comando; resumo de out/2026 diz Root > System > Developer > User > Guideline [NÃO VERIFICADO, fonte secundária] — [xenospectrum](https://xenospectrum.com/en/openai-model-spec-2026-agent-governance/)

### Inferences
- Deriva de escopo cresce com a duração da tarefa: sinal direto para travas em tarefas longas.

## Tarefas longas, interrupções, recuperação e reclamações

### Takeaway
Reclamações documentadas são anedóticas: travas, agente preso em "thinking", perda de login do navegador virtual, indisponibilidade do modo agente. Nenhum estudo sistemático de inconsistência achado.

### Cited Findings
- Fóruns: modo agente preso, "Use cloud browser" não ativa, menu do agente sumiu para Plus; suporte diz ter implantado melhorias — [OpenAI Community](https://community.openai.com/t/error-on-agent-mode-capability/1375715), [OpenAI Community](https://community.openai.com/t/agent-mode-menu-disappeared-after-recent-performance-issues-plus-plan/1386007/2), [Scalevise](https://scalevise.com/resources/chatgpt-agent-not-working-heres-how-to-fix-common-issues/)
- Dots: pausar/retomar; "decide quando pausar e retomar"; conexão expirada exige reconectar; só um computador pessoal por vez, online e com app aberto — [Flavio Copes](https://flaviocopes.com/openai-dots/)

### Gaps
- Sem reclamações específicas sobre dots (muito recente); sem dados de taxa de falha.

## Princípios publicados (Model Spec) — clarificação e autonomia

### Takeaway
Spec descreve autonomia dentro de escopo acordado, comunicação de efeitos colaterais e perguntas de esclarecimento quando ações dependem de suposições sobre intenção; detalhes de out/2026 só em fontes secundárias.

### Cited Findings
- Ver [OpenAI](https://openai.com/ga-IE/index/our-approach-to-the-model-spec/) e [xenospectrum](https://xenospectrum.com/en/openai-model-spec-2026-agent-governance/); versões antigas listam perguntar para esclarecer como comportamento padrão — [Model Spec 2025-02-12](https://hn.jakechampion.name/reader/https://model-spec.openai.com/2025-02-12.html)
- "Escopo, custo e condições de parada" definidos nas implantações autônomas — fonte secundária [NÃO VERIFICADO]

### Gaps
- Texto primário em model-spec.openai.com não lido.
