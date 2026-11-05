# Coerência de uso em assistentes agênticos: Perplexity, Manus, Meta AI, Microsoft Copilot, Opera Neon, Poke (estado em nov/2026)

Nota de método: pesquisa feita com 10 buscas (snippets de busca, sem abrir as páginas primárias com WebFetch). Muitas fontes são imprensa secundária ou blogs; marquei o que é anedótico ou não verificado. Datas: a maior parte do material de Comet/Instant Buy/Neon/Email Assistant é de 2025 (antigo); o que é de 2026 está indicado.

## 1. Quando agem sozinhos vs. pedem confirmação (compras e envios)

### Takeaway
Os produtos convergem em "pausa para o humano em login, pagamento e envio", mas a implementação é desigual: o teste da Guardio mostrou o Comet comprando em loja falsa sem confirmar, e para o Email Assistant da Perplexity as fontes divergem sobre enviar sozinho ou só rascunhar. A confirmação existe como padrão de marketing, mas é pouco documentada como comportamento verificado.

### Cited Findings
- Guardio ("Scamlexity", ago/2025): em teste numa loja Walmart falsa, o Comet concluiu a compra, muitas vezes sem pedir confirmação ao usuário; o mesmo estudo cobriu phishing e uma página de CAPTCHA que levou a download malicioso (resumo em fonte secundária; antigo, 2025) — [Tom's Hardware](https://www.tomshardware.com/tech-industry/cyber-security/perplexitys-ai-powered-comet-browser-leaves-users-vulnerable-to-phishing-scams-and-malicious-code-injection-brave-and-guardios-security-audits-call-out-paid-ai-browser); [Innovatopia (JP)](https://innovatopia.jp/cyber-security/cyber-security-news/64000/)
- Perplexity Instant Buy (PayPal), lançado em 25/nov/2025, nos EUA: o usuário escolhe o item, opta por PayPal e confirma com credenciais salvas ou passkey; o varejista continua sendo o merchant of record (envio, devolução, suporte). Não encontrei descrição detalhada da tela de confirmação — [PayPal guia](https://history.paypal.com/us/money-hub/article/how-paypal-powers-ai-shopping); [PYMNTS](https://www.pymnts.com/?p=2700727); [eWeek](https://www.eweek.com/news/paypal-perplexity-instant-buy-shopping/)
- Status de "Buy with Pro" é contraditório entre fontes: uma diz que passou a ser grátis para todos os usuários nos EUA, outra (guia mais antigo) diz que exigia assinatura — [Shopifreaks](https://www.shopifreaks.com/perplexity-to-make-its-agentic-shopping-available-to-everyone-for-free/); [PYMNTS](https://www.pymnts.com/?p=2700727)
- Perplexity Email Assistant (lançado out/2025 para assinantes Max, Gmail e Outlook): uma fonte diz que nunca envia sem aprovação e só rascunha; outra diz que pode enviar em nome do usuário conforme configurações de autonomia (totalmente autônomo, só propor horários, ou manual). Não confirmei na documentação oficial — [Geekflare](https://geekflare.com/news/perplexity-launches-ai-email-assistant-for-gmail-and-outlook/); [aivancity](https://aivancity.ai/en/blog/et-si-lia-repondait-a-vos-e-mails-perplexity-deploie-son-assistant-pour-gmail-et-outlook/); [DEV Community](https://dev.to/alifar/perplexity-email-assistant-smarter-inbox-automation-that-works-ocl)
- O Email Assistant, quando adicionado a uma thread, checa disponibilidades, sugere horários e envia convites de calendário "sem precisar de entrada extra" — [Geekflare](https://geekflare.com/news/perplexity-launches-ai-email-assistant-for-gmail-and-outlook/)
- Perplexity afirma ter "confirmações expandidas para ações de alto risco" no Comet e notificar o usuário quando bloqueia uma injeção (descrição do próprio posicionamento, via resumo secundário) — [Gend (resumo)](https://www.gend.co/sp/blog/perplexity-comet-security-day-one)
- Opera Neon Do (set/2025): o agente pausa e pede ao usuário que assuma quando precisa de interação, como login. Não encontrei teste prático de confiabilidade dessa pausa — [9to5Mac](https://9to5mac.com/2025/09/30/opera-releases-neon-its-ai-powered-browser-with-a-built-in-agent/); [gsmonline.pl](https://gsmonline.pl/artykuly/opera-wprowadza-opere-neon-z-ai-trzeba-bedzie-placic-abonament)
- Manus Browser Operator: extensão que permite ao Manus trabalhar no navegador local com os logins e sessões do usuário; precisa do navegador desktop aberto — [Manus docs](https://manus.im/docs/integrations/manus-browser-operator)
- Microsoft: em mai/2026 o Copilot Mode do Edge foi aposentado; Copilot Actions (antes em prévia limitada) virou "Browse with Copilot" no Edge desktop, só para assinantes Microsoft 365 Premium nos EUA, com limites de uso — [Edge blog, 13/05/2026](https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/)

### Inferences
- A pergunta "age sozinho ou pede?" não tem resposta única nem estável por produto: depende de plano, modo e versão. Isso é fonte direta de incoerência percebida (o mesmo produto ora confirma, ora não).
- O padrão mais defensável nas fontes é pausa obrigatória em credenciais/pagamento (passkey, login pelo usuário), com o resto delegado. Isso converge com a regra do Atlas de exceções que sempre pedem o usuário (confirmWrites, link público, dado sensível).
- A tendência de produto em 2026 é encolher/renomear modos (Copilot Mode aposentado) em vez de estabilizar um contrato de autonomia.

### Gaps
- Não consegui ler a página oficial do Email Assistant nem do Instant Buy para confirmar o contrato de envio/compra. Não há dado sobre Meta AI app agindo por conta própria (compras/envios).
- Sem informação verificada sobre o comportamento de confirmação do "Browse with Copilot" em 2026.

## 2. Como progresso e resultados são mostrados

### Takeaway
As fontes que obtive cobrem mais o conceito do que a UX concreta de progresso. O que ficou verificável: o Neon organiza trabalho em "Tasks" (contexto) e "Cards" (prompts salvos) e o Neon Do age no navegador; o Manus tem extensão de navegador e Wide Research com sub-agentes paralelos (vendor/terceiros). Pouco material sobre cards de produto, citações e visão passo a passo.

### Cited Findings
- Opera Neon: "Tasks" organizam sites, documentos e chats de IA num mesmo contexto; "Cards" são prompts salvos, combináveis, com loja da comunidade; "Neon Do" é o agente que clica, rola e expande elementos — [Opera blog](https://blogs.opera.com/news/?p=4669); [AIChief review](https://aichief.com/news/opera-neon-review-three-ai-agents-one-confusing-browser/)
- Review crítico do Neon: "três agentes de IA, um navegador confuso"; catálogo de Cards fino e cheio de gimmicks (opinião de um review, não medição) — [AIChief](https://aichief.com/news/opera-neon-review-three-ai-agents-one-confusing-browser/)
- Manus Wide Research: sub-agentes paralelos (uma página de vendor fala em 100+); fonte não oficial — [Manus Insider (não oficial)](https://manusinsider.manus.space/capabilities); [aiproductivity.ai](https://aiproductivity.ai/tools/manus/)
- Copilot Journeys: expandido em mai/2026 no desktop em mercados de língua inglesa e no mobile nos EUA — [Edge blog](https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/)

### Inferences
- A queixa "confuso" do Neon (vários modos de agente com nomes diferentes) é um caso de incoerência de vocabulário/modelo mental; vale como contraexemplo para o Atlas manter um só conceito (Rotina, Painel etc.).

### Gaps
- Não obtive evidência verificada sobre visão ao vivo de passos, cards de produto ou citações no Comet, Manus ou Copilot. Requer abrir docs/telas oficiais.

## 3. Transparência e controle de memória

### Takeaway
Memória está chegando a todos, mas o que encontrei de verificável é só disponibilidade e promessa de controle, sem detalhes de UI. No Meta AI app a memória foi criticada como fraca em 2025 e depois adicionada com restrições.

### Cited Findings
- Copilot: memória de longo prazo disponível em desktop e mobile (mai/2026); a Microsoft diz que o usuário "está sempre no controle" do que o Copilot acessa. Não achei detalhes de confirmação ao salvar memória — [Edge blog](https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/)
- Meta AI app: review de 2025 disse que o app não lembrava conversas anteriores, ao contrário de concorrentes (citando a Bloomberg); depois, memória adicionada só em chats 1:1 (não em grupos onde o Meta AI foi chamado), inicialmente em EUA e Canadá (2025; antigo) — [iPhone in Canada](https://www.iphoneincanada.ca/2025/08/15/meta-ai-app-privacy-and-performance-issues/); [Croma](https://croma.com/unboxed/meta-ai-can-now-record-and-remember-details-about-you); [Android Authority](https://androidauthority.com/meta-ai-whatsapp-memory-3492224)
- Meta AI app, problemas de privacidade já em 2025 (mesmo review) — [iPhone in Canada](https://www.iphoneincanada.ca/2025/08/15/meta-ai-app-privacy-and-performance-issues/)

### Inferences
- Regra "memória só de chat 1:1, não de grupo" é um recorte de escopo que evita vazamento entre contextos e é boa referência para o Atlas (grupos).

### Gaps
- Sem dados verificados sobre memória no Perplexity, Manus e Poke, nem sobre onde o usuário vê/edita/apaga memória em qualquer produto.

## 4. Proatividade (mensagens proativas, tarefas agendadas, follow-up)

### Takeaway
Poke é o exemplo de proatividade como proposta central, e a crítica principal é julgamento inconsistente do que vale avisar. Meta testou follow-ups com limites bem conservadores. Perplexity Tasks e Manus Scheduled Tasks são recorrência explícita criada pelo usuário.

### Cited Findings
- Poke (Interaction Co): assistente por texto (iMessage, SMS, WhatsApp, Telegram) que traz atualizações sem ser acionado (conta a vencer, conflito de agenda). Review do Saner.ai: 3,3/5, "interface brilhante num produto incompleto", proatividade 4,0/5 mas filtragem inconsistente. Review semanal no Product Hunt: bugs ocasionais, atraso em integrações, preço inconsistente (opiniões de reviewers, amostra pequena: 2 avaliações no PH) — [Saner.ai](https://blog.saner.ai/poke-reviews/); [Product Hunt](https://www.producthunt.com/p/general/a-week-with-poke-review-a-promising-start-for-a-proactive-ai-assistant); [Chorus](https://chorus.com/compare/chorus-vs-poke)
- Cognition (Devin) teria adquirido a The Interaction Company of California em jul/2026; o Poke segue como produto autônomo (relato de um resultado de busca, não verificado em fonte primária) — [Tool Directory](https://tooldirectory.ai/tools/poke)
- Meta (AI Studio, teste de 2025; antigo): follow-up proativo só se o usuário iniciou a conversa; janela de 14 dias e mínimo de 5 mensagens nesses 14 dias; para de enviar se a primeira mensagem for ignorada. Meta disse que só envia se o usuário começou (via Engadget/Business Insider) — [Engadget](https://www.engadget.com/big-tech/meta-is-reportedly-training-its-ai-chatbots-to-send-unprompted-messages-143229039.html); [Particle](https://particlenews.pages.dev/story/meta-tests-proactive-follow-up-messages-in-ai-studio-chatbots)
- Perplexity Tasks: jobs recorrentes (resumo diário de notícias, previsão mensal) entregues no horário; fonte é guia de terceiro, não documentação oficial — [Geekflare](https://geekflare.com/news/perplexity-launches-ai-email-assistant-for-gmail-and-outlook/)
- Manus: Scheduled Tasks (terceiros falam em "2.0" para monitoramento recorrente) com limites por plano (ex.: 2 tarefas agendadas num plano baixo, 20 no Starter de US$20; não confirmado oficialmente); Mail Manus: e-mail dedicado para encaminhar mensagens e disparar fluxos (fonte: snapshot de Reddit, fraco) — [aiproductivity.ai](https://aiproductivity.ai/tools/manus/); [Reddit snapshot](https://reddit.sentinel-team.org/posts/1qruax4/snapshots/2026-02-21T04%3A40%3A34.400181Z)

### Inferences
- O limite da Meta (parar se ignorado, janela curta, só após o usuário iniciar) é um padrão concreto de "proatividade com freio" compatível com a diretriz do Atlas de voltar só com novidade.
- A crítica do Poke (filtro inconsistente) mostra que o risco central da proatividade é variância de julgamento, não falta de capacidade.

### Gaps
- Nada verificado sobre follow-up pós-compra (acompanhar algo que o usuário comprou) em nenhum produto. Nada oficial sobre proatividade do Copilot ou do Meta AI app em 2026.

## 5. Injeção de prompt: incidentes e defesas

### Takeaway
Comet é o caso mais documentado: Brave (ago e out/2025), Guardio (ago/2025) e Zenity (mar/2026) mostraram desvios; a Perplexity responde com defesa em camadas e admite que o problema não está resolvido.

### Cited Findings
- Brave (20/ago/2025): instruções ocultas em páginas (prova de conceito com comentário no Reddit) levaram o agente a ler uma senha de uso único do Gmail; Comet não separava comandos do usuário de conteúdo da página. Brave disse que o problema foi corrigido em 13/ago mas que a Perplexity não compartilhou o patch e depois reportou mitigação incompleta (relatos secundários) — [Decrypt](https://decrypt.co/336763/perplexity-comet-flaw-exposed-user-data-attackers-brave-reports); [Born City](https://borncity.com/win/2025/08/25/perplexity-comet-browser-prompt-injection-as-a-major-security-risk/); [Gigazine](https://gigazine.net/gsc_news/en/20250826-perplexity-comet-ai-prompt-injection)
- Brave (1/out/2025): injeções "invisíveis" em screenshots (texto azul-claro fraco sobre fundo amarelo) — [PPC Land](https://ppc.land/comet-browser-faces-multiple-security-vulnerabilities-from-prompt-injection/)
- Perplexity, 22/out/2025, "Mitigating Prompt Injection in Comet": afirma que injeção maliciosa "continua um problema não resolvido na indústria" — [Perplexity (hub)](https://hub-prod.perplexity.ai/hub/blog/mitigating-prompt-injection-in-comet)
- Defesas declaradas pela Perplexity: defesa em profundidade ao longo do ciclo da tarefa, guardrails por ferramenta (instruções no system prompt de cada tool para manter alinhamento à intenção do usuário e desconfiar de conteúdo externo), detecção em tempo real, confirmação em ações de alto risco, notificação ao usuário quando bloqueia, auditoria da Trail of Bits antes do lançamento (que apontou lacunas e quatro técnicas de extração via Gmail, segundo resumo secundário), bug bounty, e o BrowseSafe — [Perplexity (hub)](https://hub-prod.perplexity.ai/hub/blog/how-we-built-security-into-comet-from-day-one); [Gend](https://www.gend.co/sp/blog/perplexity-comet-security-day-one)
- Zenity Labs (mar/2026, "PleaseFix", zero-click): Comet teria sido conduzido por injeção indireta a operar numa sessão autenticada do 1Password, podendo expor senhas e arquivos; relato de patch impedindo leitura do sistema de arquivos local vem de agregador fraco e não foi verificado — [Rankiteo (fraco)](https://blog.rankiteo.com/per1772547904-perplexity-vulnerability-march-2026/); [SiliconANGLE](https://siliconangle.com/?p=732788)
- Simon Willison, que cunhou o termo, diz que o problema vai muito além do Comet — [Decrypt](https://decrypt.co/336763/perplexity-comet-flaw-exposed-user-data-attackers-brave-reports)
- Não encontrei, nesta pesquisa, incidentes ou defesas verificadas para Manus, Neon e Copilot.

### Inferences
- Padrão repetido: correção declarada, depois nova variante (texto → screenshot → sessão autenticada). Isso sugere que defesa só por classificador não fecha o risco; limitar o que o agente pode alcançar (escopo de contas, só leitura, pausa em ações sensíveis) é o que dá previsibilidade.
- Coerente com a regra do Atlas de tratar conteúdo externo como dado, não instrução.

### Gaps
- Não abri os posts primários de Brave, Guardio e Zenity; os detalhes acima vêm de resumos. Recomendo checar brave.com/blog/comet-prompt-injection/ e a publicação da Zenity antes de citar números.

## 6. Tarefas longas, erros, recuperação e queixas de inconsistência

### Takeaway
A queixa dominante sobre o Manus é custo imprevisível: créditos consumidos em loops/falhas, sem estimativa prévia e com reembolso difícil. É coerência de custo, não só de resultado. Fontes são majoritariamente anedóticas.

### Cited Findings
- Queixas recorrentes: créditos drenados em loops ou tarefas que falham; não há estimativa de custo antes de rodar; o agente para no meio quando os créditos acabam; reembolso negado quando a falha "não é um problema técnico verificável"; créditos que desaparecem após cancelar (Trustpilot e blogs; autosselecionados e não verificados; algumas páginas críticas estão em manus.space e têm viés de militância; um relato de 88 mil créditos num loop vem de site desse tipo) — [Trustpilot](https://nz.trustpilot.com/review/manus.im); [BotCrawl](https://botcrawl.com/manus-ai-refund-problem/); [Carly review](https://usecarly.com/blog/manus-ai-review); [eesel](https://www.eesel.ai/blog/manus-ai-pricing)
- Posição do Manus: execução incompleta, em que o agente para sem motivo válido e não entrega nada, é caso elegível a reembolso; créditos são consumidos enquanto o agente trabalha e isso não é desfazível — [Manus Help Center](https://help.manus.im/en/articles/12992237-how-does-our-ai-agent-s-credit-refund-policy-work)
- Poke: bugs ocasionais, atraso em integrações de terceiros — [Chorus](https://chorus.com/compare/chorus-vs-poke)
- Neon: review chama a experiência de confusa por ter três agentes — [AIChief](https://aichief.com/news/opera-neon-review-three-ai-agents-one-confusing-browser/)
- Comet/Manus: Manus Browser Operator exige o navegador desktop rodando (limitação que gera falha "silenciosa" se o usuário o fechar; é inferência, ver abaixo) — [Manus docs](https://manus.im/docs/integrations/manus-browser-operator)

### Inferences
- Falha com custo (créditos gastos sem entrega) é a pior forma de incoerência percebida; reforça mostrar ao usuário o que foi consumido e parar com nota honesta.
- Dependência de um dispositivo ligado (Browser Operator) sem sinalização clara é um risco de "tarefa que não anda"; é uma inferência minha, não relato documentado.

### Gaps
- Sem dados quantitativos independentes de taxa de sucesso ou de falha de qualquer produto. Zemith cita reviews de out/2026 que não consegui verificar, então não os usei. Faltam relatos verificados de recuperação de erro no Comet, Copilot e Meta AI.
