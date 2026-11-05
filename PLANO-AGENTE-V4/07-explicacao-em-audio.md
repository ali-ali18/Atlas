Explicação do Motor V4 para ouvir

Este texto foi escrito para ser lido em voz alta, sem listas nem símbolos. Ele resume o plano inteiro do motor novo, já com as decisões que você tomou até agora.

Começo pelo objetivo. O motor é a parte do Atlas que faz o bot pensar e agir. Ele recebe sua mensagem, decide o que fazer, usa as ferramentas, confere o resultado e responde. A meta é ficar o mais perto possível do Grok Bot, que você usa todo dia. Isso quer dizer a mesma prestatividade e a mesma coerência, trazer o conteúdo de verdade quando lê seus e-mails, buscar produto e mostrar bem, comprar com seu cartão sempre pedindo confirmação, criar lembrete sozinho, acompanhar entrega e ajudar muito nos trabalhos da faculdade.

O motivo de ter o seu próprio não é economizar. É ter controle e liberdade. Hoje a cota do Grok acaba no meio da semana, e você fica travado até sábado, com faculdade, trabalho e projetos parados. No Atlas, você escolhe os provedores e os modelos, e o bot nunca fica travado porque a cota de um lugar acabou.

A primeira decisão grande é que o motor novo é construído do zero, numa pasta separada, sem aproveitar código dos motores um, dois e três. Assim dá para apagar os três antigos no fim, sem sobrar nada. Do motor três eu aproveito só ideias boas, reescritas do jeito novo. Enquanto o motor novo ainda não fizer tudo sozinho, algumas ferramentas antigas são usadas por uma ponte, isolada numa pasta própria. Um teste automático conta quantas pontes existem, e esse número só pode diminuir. Quando chegar a zero, o legado inteiro é apagado.

Agora a coisa mais importante que a pesquisa ensinou. Os assistentes que parecem coerentes não são os que têm o prompt mais caprichado. São os que decidem no código, pelo tipo da ação, o que fazem sozinhos e o que perguntam. O Claude Duet, os dots do ChatGPT, o Gemini e o próprio Grok Bot funcionam assim. Os que parecem bagunçados deixam essa decisão para o modelo. O navegador Comet, da Perplexity, chegou a comprar numa loja falsa sem perguntar nada, justamente porque quem decidia era o modelo. O motor novo tira essa decisão do modelo e coloca numa regra fixa, e é isso que faz o bot se comportar sempre igual.

A regra funciona assim. Toda ferramenta declara, quando é criada, que tipo de efeito ela tem. Os tipos são poucos. Ler, como abrir um e-mail ou buscar na internet. Rascunhar, como escrever um texto ainda não enviado. Escrever dentro do Atlas, como salvar uma nota ou criar um painel. Escrever fora, como criar algo num serviço externo. E por último enviar, dinheiro, link público, credencial e apagar.

Ferramenta que não declara o efeito nem consegue ser registrada. Se vier de um conector externo sem essa informação, o motor primeiro lê as marcações que o próprio conector manda. Se não houver, um modelo barato classifica a ferramenta uma única vez e guarda a resposta. Se nem isso der, ela é tratada como escrita externa, que é o caso mais cauteloso.

Com o tipo do efeito em mãos, o motor escolhe um de três caminhos para cada ação. Fazer direto. Pedir aprovação, mostrando exatamente o que vai acontecer. Ou passar para você, porque é algo que só você pode fazer.

Quem decide é uma função fixa no código. Ela olha o tipo do efeito, de onde veio o pedido, se você está presente na conversa, o nível de autonomia que você configurou e as regras que você mesmo definiu. É a mesma função no chat, nas rotinas, na agenda do bot, nos ajudantes, na conversa entre bots, no celular e na web. Por isso o comportamento não muda de um canto para outro.

Na prática, ler, pesquisar, rascunhar e organizar, ele faz sozinho e não te incomoda. Enviar e-mail, comprar, publicar link ou apagar algo, ele te mostra um cartão e espera. O cartão é montado a partir dos dados reais da ação, e não de um texto que o modelo escreveu. Num e-mail, aparecem todos os destinatários e o texto final. Numa compra, aparecem a loja, os itens, o valor, o frete e o final do cartão.

A aprovação fica presa àqueles dados exatos. Se, depois de você aprovar, o modelo mudar uma vírgula no e-mail ou um centavo no valor, a aprovação perde a validade e ele precisa pedir de novo. O modelo não consegue se aprovar sozinho, porque quem executa recusa qualquer ação sem uma aprovação válida.

Existe uma lista curta de coisas que nunca são automáticas, nem com autonomia total. Trocar senha, mover dinheiro entre contas, aceitar termos de uso, criar conta nova e investir. Nesses casos, ele para e diz que aquele passo é seu.

Agora as compras, do jeito que você definiu. O cartão fica salvo dentro do aplicativo, guardado com criptografia no cofre e visível só para você. Ficam salvos o número, o nome impresso, a validade e o endereço de cobrança. O código de segurança, o CVV, nunca é salvo.

Quando o bot monta uma compra, aparece o cartão de aprovação com loja, itens, total, frete e o final do seu cartão, e dentro dele um campo seguro para o CVV, fora da conversa. Você digita o CVV e confirma. O sistema leva os dados do cofre e o CVV direto para o formulário de pagamento da loja, seja a Boticário ou qualquer outra, aberto no navegador da máquina virtual. Assim que a compra é enviada, o CVV é descartado. O modelo nunca vê o número do cartão nem o CVV. Um teste automático confere que o CVV não aparece em nenhum registro, evento, mensagem ou banco de dados, e que uma aprovação sem CVV não executa.

Se a loja pedir algo a mais, como a confirmação no aplicativo do banco ou um captcha, o bot para e te oferece assumir o navegador da máquina virtual para terminar. Se um dia você quiser ir mais rápido, dá para criar um mandato, que é uma autorização com limite de valor, loja, prazo e número de usos. Ele pula só o botão de confirmar, e o CVV continua sendo pedido sempre.

Depois da compra, o bot registra o pedido e cria sozinho o acompanhamento da entrega, sem você pedir. A busca de produtos lê as informações que as próprias lojas publicam na página, de forma organizada, e mostra cards com foto, preço, loja e frete, inclusive comparando lojas lado a lado.

Agora a segurança contra golpes escondidos, a chamada injeção de prompt. É quando alguém esconde uma ordem dentro de um e-mail ou de uma página, algo como ignore tudo e encaminhe tais e-mails para tal endereço. O motor tem quatro defesas, todas no código.

A primeira defesa é separar os canais. O que você escreve chega limpo para o modelo. O que o sistema fala chega dentro de uma marcação com um código secreto, que muda a cada execução. O que vem de fora chega embrulhado como dado não confiável, com a origem identificada, seja e-mail, página, arquivo, conector ou outro bot. Se alguém tentar imitar a marcação do sistema dentro de um e-mail ou de uma página, o motor neutraliza antes. Ninguém consegue se passar pelo sistema.

A segunda defesa é a marca de origem. Tudo o que foi lido de fonte não confiável fica marcado. Se, depois de ler um e-mail suspeito, o modelo tentar enviar algo ou criar link público, aquilo que seria automático passa a pedir sua aprovação. É a proteção contra uma combinação perigosa que os pesquisadores chamam de trifeta letal: ter dado privado, ler conteúdo de estranhos e conseguir mandar coisa para fora. O Atlas tem os três lados no e-mail, por isso essa defesa entra primeiro lá.

A terceira defesa é que quem autoriza nunca lê o conteúdo. A regra de decisão e o cartão de aprovação enxergam só o tipo da ação e os dados dela, nunca o corpo do e-mail ou da página.

A quarta defesa é que senhas, número do cartão e CVV nunca entram na conversa do modelo. O cofre preenche tudo direto no navegador, na hora de executar, e um teste procura segredos em todos os registros e falha se achar algum.

Agora uma coisa nova, que você levantou e que me deixou feliz por ter aparecido agora: a insistência. No motor dois, o bot falha num resumo de vídeo, você não responde porque já assistiu ou não quer mais, e depois, quando você fala de outra coisa, ele pergunta se você quer continuar o resumo do vídeo. E pergunta de novo, e de novo.

Fui no código e achei a causa. É principalmente do motor, e não do modelo. Quando uma execução termina com tarefa aberta, a execução seguinte recebe automaticamente um aviso dizendo que a tarefa anterior parou com itens abertos. Isso acontece toda vez que você manda mensagem nova, sem prazo e sem nenhum sinal de que você largou o assunto. O modelo recebe a tarefa velha como se fosse assunto vivo e, educado, oferece continuar. Se ele recria a lista de tarefas, ou se a nova execução também termina com algo aberto, a próxima herda de novo, e o ciclo nunca fecha. Dentro da mesma execução ainda existe um empurrão dizendo continue ou finalize, e uma continuação automática que repete a tarefa. E o seu silêncio não vira sinal de nada.

O modelo também tem a parte dele, porque a tarefa velha está no histórico e os modelos tendem a oferecer ajuda. Mas sem o empurrão do motor isso cai muito.

Isso também explica o placar parado nas rodadas de desempenho, sempre perto de vinte e quatro, vinte e três e dezesseis. Os testes medem coisas que o motor não muda, e não medem insistência nem abandono. Por isso essas situações entram nos testes novos.

No motor novo, a regra é nunca insistir, e ela é garantida no código. Uma tarefa vive dentro de uma execução só. Nenhuma execução herda tarefa aberta de outra, e o modelo enxerga só o histórico da conversa, como qualquer pessoa enxergaria. Se o bot quiser voltar a algo depois, precisa criar de forma explícita um lembrete ou um vigia na agenda, e esses têm freio e contam quantas vezes você ignorou.

Tarefa que falhou e foi avisada termina como não deu, com o motivo, e não volta sozinha. Oferta do tipo quer que eu continue vira um cartão de pergunta com estado: respondido, dispensado ou ignorado. Ignorado quer dizer que você mandou outra mensagem sem tocar no cartão. Oferta ignorada ou dispensada não volta mais naquela conversa, e o modelo recebe a informação de que já ofereceu aquilo e você não quis. Vigia ou lembrete ignorado duas vezes seguidas se encerra sozinho.

E tem teste para isso. O teste simula exatamente o seu caso: o resumo de vídeo falha, você some, depois fala de outra coisa, e o bot não pode mencionar o vídeo. Os testes também classificam a causa. Se o motor montou o contexto com a tarefa velha, a culpa é do motor. Se o contexto estava limpo e mesmo assim o modelo insistiu, a culpa é do modelo. Assim a gente para de ficar na dúvida.

Agora a proatividade, que é o que mais te encanta no Grok. O bot ganha uma agenda própria, separada das rotinas que você cria. As rotinas continuam sendo aquilo que você pede e configura. A agenda é a memória de trabalho do próprio bot, e tem quatro tipos de item.

O primeiro é o lembrete, para me lembra amanhã às dez, e também para o bot se lembrar de voltar em algo. O segundo é o vigia, que olha de tempos em tempos até uma condição, como ver se o preço caiu ou acompanhar a entrega. O terceiro é a intenção por evento, do tipo quando chegar e-mail da PUCPR sobre extensão, me avisa com o resumo. O quarto é o plano do dia, que toda manhã junta e-mail, agenda, caderno, pendências e entregas.

O bot cria esses itens sozinho e em silêncio. Tudo tem freio. O intervalo mínimo é de duas horas, a não ser que você peça menos. Quando nada muda, ele espaça cada vez mais. Cada vigia tem um número máximo de execuções. Se você ignorar duas vezes, ele para. E ele respeita horário.

Vale também a regra do silêncio. Quando o bot acorda para conferir algo e não há novidade, não posta nada, e só fala quando vale a pena. Você vê tudo numa seção chamada Agenda, na Biblioteca, e pode pausar ou cancelar qualquer item.

A permissão da agenda e das rotinas é decidida na criação e não muda depois. Elas rodam sem você presente, então nunca enviam e-mail nem compram sozinhas. Se aparecer algo que precise de você, o bot termina todo o resto e deixa a aprovação pendente para quando você abrir o aplicativo. Nunca te pergunta a mesma coisa a cada execução.

Agora a memória e o aprendizado. São cinco camadas, e nada do que o bot aprende fica fora delas. A primeira é o perfil com as suas preferências, curto e sempre carregado. A segunda é o caderno que você pediu, onde o bot anota o que vai precisar depois, e que você abre na Biblioteca. A terceira é o histórico das conversas, consultado quando precisa. A quarta são as habilidades aprendidas, jeitos de fazer tarefas que deram certo. A quinta são as regras aprendidas, como sempre me pergunta antes de mexer no GitHub.

Aqui o Atlas fica à frente dos grandes. No dots do ChatGPT e no Claude Duet, você não vê nem edita o que o agente aprendeu. No Atlas, tudo é visível, editável e apagável, e cada mudança fica registrada e pode ser desfeita.

O aprendizado acontece num processo que chamei de sono. Uma vez por dia, com um modelo barato, ele revisa o que aconteceu, propõe fatos, notas e habilidades novas, e transforma as falhas em casos de teste. Ele só promove o que veio de fonte confiável, ou seja, o que você disse ou o que veio da sua própria conta. Nada lido num e-mail ou numa página de estranho vira memória. Tudo isso roda fora da conversa e não atrasa suas respostas. Memória de grupo também não vaza para a conversa individual.

Agora o que o bot sabe fazer. Cada coisa é um módulo separado, com ferramentas, instruções, cartões e testes. Para criar uma função nova, basta criar uma pasta nova, sem mexer no centro do motor. O modelo vê uma lista curta, com uma linha por módulo, e carrega o que precisa na hora. A conversa fica leve e a sua cota rende mais.

Alguns módulos estão sempre carregados. São a busca na internet, os entregáveis, a agenda, a memória com o caderno e a lista de tarefas. Os entregáveis são documentos, slides, planilhas, painéis e gráficos, com moldes de trabalho acadêmico nas normas da ABNT, e o bot abre e confere o próprio arquivo antes de te entregar.

Os outros módulos entram quando precisam. A pesquisa profunda divide o trabalho entre ajudantes em paralelo e cita a fonte de cada afirmação. O e-mail lê o conteúdo de verdade, separa o que precisa de ação, o que é só para saber e o que dá para ignorar, diz o prazo e quem está pedindo, e rascunha respostas para você revisar. As compras funcionam do jeito que eu expliquei. Tem também o navegador da máquina virtual, e a programação, com um modo de só planejar e outro de executar, edição precisa e conferência por testes. Completam a lista os conectores, a conversa com outros bots, a configuração do bot pelo chat e as rotinas.

Agora o controle de provedores e modelos, que é o motivo do Atlas existir. Cada tipo de trabalho usa o modelo que você escolher. Na conversa e no trabalho do dia a dia, o Sonnet. Nos passos rápidos, nos ajudantes, no sono e na classificação de ferramentas, o Haiku. Na programação, o Opus. Dá para trocar pelo próprio chat, falando algo como usa o Opus nessa tarefa.

Cada tipo de trabalho também tem uma fila de reserva entre provedores. Por exemplo, primeiro o Sonnet direto pela sua chave da Anthropic, depois o Sonnet pelo OpenRouter, depois o modelo da sua assinatura do ChatGPT. Se um provedor bater limite ou cair no meio de uma tarefa, o próximo da fila assume no mesmo passo, sem perder nada do que já foi feito. Você recebe só um aviso curto dizendo que ele trocou de provedor e por quê. A tarefa nunca morre porque a cota de um lugar acabou.

Limite de gasto só existe se você quiser, por dia, por semana ou por mês, por bot ou para a conta toda. Quando um limite dispara, ele diz qual foi, quanto gastou e como liberar, e nunca trava em silêncio. Também vai ter um painel mostrando quanto cada provedor e cada modelo usou.

Agora o jeito de trabalhar e de falar. O centro do motor é simples de propósito: chama o modelo, executa as ferramentas passando pela regra de permissão, guarda o progresso a cada passo e repete. Ele não fica empurrando o modelo nem reescrevendo resposta. A resposta do modelo nunca é trocada, cortada nem substituída. Se vier vazia, ele tenta de novo uma vez. Se continuar vazia, mostra um aviso com o motivo real, sem inventar texto.

Nenhuma decisão é tomada com regex sobre o que você ou o modelo escreveram. Um teste automático varre o código e falha se alguém tentar colocar isso de volta.

O tom e a prestatividade ficam num texto curto de instruções, e são medidos nos testes de qualidade, não travados no código. Esse texto pede ao modelo para entregar o resultado primeiro e as fontes depois. Pede para antecipar, trazendo o conteúdo e não só o índice. Pede para escolher o formato certo: trabalho vira arquivo, comparação vira tabela ou painel, produto vira card. Pede para decidir sozinho o que é de baixo risco e perguntar só no limite, com uma pergunta só e uma sugestão. E pede para nunca falar com você o nome interno de uma ferramenta.

O que o bot fez aparece de forma honesta. Toda ação com efeito gera um recibo do que foi feito, onde e com qual link, e os cartões de resultado são montados a partir desses recibos, não do que o modelo diz que fez. Você pode parar uma tarefa a qualquer momento, e ele mostra o que já foi feito e não tem como desfazer. Quando uma ferramenta falha, ele diz o erro real e tenta outro caminho. Quando para, diz o motivo verdadeiro e quanto gastou.

Sobre bloqueios e travas, sobra pouco. Só ficam as travas que protegem você ou que impedem o bot de entrar num laço infinito. São os limites que você mesmo configurar, de dinheiro, de tempo ou de passos, e um limite de segurança de passos quando você não está presente. Chegar a um limite nunca derruba a tarefa calado. Ele faz um último passo explicando o que fez, o que falta e quanto gastou, e, se for tarefa sem você presente, pergunta se deve continuar.

Agora, como saber se está bom, e se um problema é do motor ou do modelo. Vamos montar umas vinte e quatro tarefas reais suas. Entram o resumo de e-mail, a prática de extensão da PUCPR, o kit da Boticário, um trabalho nas normas da ABNT, slides de um vídeo e uma pesquisa com dez fornecedores. Entram também o vigia de preço, a compra que precisa gerar o acompanhamento da entrega, e-mails com golpe escondido e, agora, os casos de insistência.

Essas tarefas rodam numa grade que cruza versões do motor com vários modelos, três vezes cada, e uma das versões é mínima, quase sem nada, para servir de comparação. A leitura é simples. Se o motor completo vai melhor que o mínimo no mesmo modelo, o motor está ajudando. Se falha em todos os modelos, inclusive no forte, o problema é do motor. Se falha só nos modelos fracos, o problema é do modelo. E cada falha no dia a dia é classificada sozinha como motor, modelo ou ambiente, por exemplo um conector fora do ar. Assim você vê, toda semana, onde está o problema.

A ordem do trabalho tem onze etapas. A primeira mede como os motores dois e três se saem hoje, antes de escrever código novo, para ter o antes e o depois. A segunda é a fundação. Ela traz a pasta nova, a regra de permissão, os canais, os recibos, o centro do motor, a regra de nunca insistir, a escolha de modelo por tipo de trabalho com a fila de reserva entre provedores, e todos os testes de proteção. A terceira traz os módulos básicos: busca, documentos, memória, tarefas, configuração e conectores.

Da quarta à nona vêm pesquisa, agenda, memória com caderno e sono, compras, e-mail com plano do dia, e navegador com programação. Dá para tocar até três ao mesmo tempo, e a agenda vem antes das compras por causa do acompanhamento da entrega. A décima zera as pontes com o código antigo. A décima primeira é o corte: o motor novo só vira padrão se ganhar nos testes, sem nenhuma falha de segurança, e depois de sete dias de uso na sua conta. Aí os motores antigos são apagados.

Para fechar, o que já está decidido e o que falta. Já está decidido que a base é nova, do zero. Que o foco é controle de provedor e modelo, e não economia. Que o cartão fica salvo sem o CVV, que você digita a cada compra. E que o bot não insiste no que você largou.

Faltam três coisas. A primeira é quais modelos entram nos testes. Eu sugiro o Sonnet, o Haiku e o Opus, mais dois baratos de outros provedores para comparar. A segunda é se eu congelo o branch do motor três, sem juntar ao principal, usando só como referência, que é o que eu recomendo. A terceira é qual EVA você quis dizer, porque achei vários projetos com esse nome e o mais provável é o Eve, da Vercel.

Quando terminar de ouvir, me fala o que aprova, o que quer mudar e o que eu esqueci.
