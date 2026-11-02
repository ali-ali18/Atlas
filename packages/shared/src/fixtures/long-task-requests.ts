/**
 * Pedidos rotulados para medir `looksLikeLongTask` (atalho por regex do perfil `auto`).
 * `long` = precisa de trabalho longo (várias fontes, entregável, etapas encadeadas); `short` = conversa, pergunta
 * de uma linha, continuação ou ação de uma só etapa.
 *
 * Regra dos ambíguos (decisão documentada): "pesquisa isso rapidinho" é `short` (o dono pediu rapidez e não
 * indicou várias fontes); "abre esse link e me diz o título" é `short` (uma etapa só); continuação curta de uma
 * conversa em andamento ("Quer tentar pegar o resumo dele?") é `short`: quem decide promover é o modelo, pela lista
 * de tarefas. Pesquisa de um assunto só, sem plural de fontes ("pesquisa na internet o dólar hoje"), é `short`:
 * a decisão de virar trabalho longo é do modelo (lista de 3+ passos), não do regex. Relato no passado ("já pesquisei
 * em várias páginas e não achei") e "check" em inglês ("check the many pages of this PDF") também são `short`.
 */
export type LongTaskLabel = "long" | "short";

export const LONG_TASK_REQUESTS: ReadonlyArray<{ text: string; label: LongTaskLabel }> = [
	// --- caso real do dono (Cookie) ---
	{ text: "Pode pesquisar pela Internet em diversas páginas né", label: "long" },
	{ text: "Quer tentar pegar o resumo dele?", label: "short" },
	{ text: "Bom dia", label: "short" },
	{ text: "Um feriado é bom né, slk", label: "short" },
	{ text: "Qual vídeo?", label: "short" },
	{ text: "Pesquisa pra mim os preços de 5 notebooks em várias lojas e compara", label: "long" },
	{ text: "Faz um levantamento dos concorrentes", label: "long" },
	{ text: "Pesquise sobre o Dots da OpenAI e compare com o Hermes, em várias fontes", label: "long" },
	{ text: "me explica o que é uma API", label: "short" },
	{ text: "pesquisa isso rapidinho", label: "short" },
	{ text: "abre esse link e me diz o título", label: "short" },
	{ text: "Monta um relatório de 5 páginas sobre X", label: "long" },

	// --- falsos positivos achados na auditoria (todos `short`) ---
	{ text: "Pesquisa na internet qual o dólar hoje, preciso saber pra fechar uma compra agora", label: "short" },
	{ text: "Pesquise online se a farmácia da esquina abre domingo, por favor", label: "short" },
	{ text: "Já pesquisei em várias páginas e não achei, o que você acha?", label: "short" },
	{ text: "Me ajuda a procurar um presente, vi várias lojas e não decidi", label: "short" },
	{ text: "Check the many pages of this PDF and tell me the total", label: "short" },

	// --- pesquisa em várias fontes, sem substantivo de entregável (pt) ---
	{ text: "Pesquisa em várias fontes sobre o novo iPhone", label: "long" },
	{ text: "Pode pesquisar na internet sobre os melhores planos de saúde para PJ e ver vários sites?", label: "long" },
	{ text: "Busca em diversos sites quanto custa um seguro de carro para um Onix 2020", label: "long" },
	{ text: "Dá uma olhada em múltiplas fontes e me diz se esse produto é confiável", label: "long" },
	{ text: "Pesquise muitas páginas e me conte o que as pessoas estão falando do novo Kindle", label: "long" },
	{ text: "Procura em vários links qual é o melhor roteador para casa grande", label: "long" },
	{ text: "Pesquisa na internet o que mudou na lei do MEI neste ano e como isso afeta quem fatura até 81 mil", label: "short" }, // um assunto só: se precisar de mais, o modelo promove pela lista de tarefas
	{ text: "Levanta em diversas fontes o preço médio do aluguel em Pinheiros", label: "long" },
	{ text: "Investiga em vários sites se esse fornecedor tem reclamações", label: "long" },
	{ text: "pesquisa pela web sobre as regras de bagagem de mão das companhias aéreas brasileiras", label: "short" }, // sem plural de fontes: o modelo promove se a lista passar de 3 passos

	// --- pesquisa em várias fontes (en) ---
	{ text: "Research this topic across several sources and tell me what you find", label: "long" },
	{ text: "Can you search the web on multiple pages about the best standing desks?", label: "long" },
	{ text: "Look through many sites and find the cheapest flight from Sao Paulo to Lisbon in March", label: "long" },
	{ text: "Search several pages for reviews of the new Pixel before I buy", label: "long" },
	{ text: "Please research on the internet how other startups price their API, check multiple sources", label: "long" },

	// --- entregável / etapas encadeadas / pedido longo ---
	{ text: "Faça uma pesquisa de mercado sobre o setor de café especial no Brasil e monte um relatório", label: "long" },
	{ text: "Research the market for specialty coffee and prepare a report with sources", label: "long" },
	{ text: "Abra o vídeo https://youtu.be/abc123, faça perguntas ao Gemini sobre ele, compare com Hermes, Dots e Grok Bot e monte um relatório", label: "long" },
	{ text: "Assista esse vídeo inteiro, resuma os pontos principais e compare com o que a gente já usa hoje no time", label: "long" },
	{ text: "Watch the whole video, summarize the main points and compare it with Hermes, Dots and Grok Bot today", label: "long" },
	{ text: "Monta uma planilha comparando os planos de internet da minha região", label: "long" },
	{ text: "Prepare a presentation about our Q3 results with the main risks", label: "long" },
	{ text: "Elabora um estudo sobre o impacto do Pix no varejo pequeno", label: "long" },
	{ text: "Gere um dashboard com as vendas do mês e compare com o mês anterior", label: "long" },
	{ text: "Write an overview of the main open-source vector databases and compare them", label: "long" },
	{
		text: "Preciso que você leia todos os e-mails de fornecedores desta semana, separe os que pedem reajuste, calcule o impacto no custo mensal e escreva um resumo para eu mandar à diretoria ainda hoje, com recomendação do que aceitar",
		label: "long",
	},

	// --- conversa, perguntas curtas, continuação ---
	{ text: "oi, tudo bem?", label: "short" },
	{ text: "qual o dólar hoje?", label: "short" },
	{ text: "obrigado!", label: "short" },
	{ text: "valeu, ficou ótimo", label: "short" },
	{ text: "Abra o link que te mandei e me diga o que é", label: "short" },
	{ text: "Resuma esse texto em duas linhas, por favor", label: "short" },
	{ text: "qual a diferença entre React e Vue?", label: "short" },
	{ text: "me diga se o Grok Bot é seu agente", label: "short" },
	{ text: "Pode abrir o link que eu mandei, resumir o texto e comparar com o outro?", label: "short" },
	{ text: "abra, leia e resuma isso aqui", label: "short" },
	{ text: "Que horas é a reunião de amanhã?", label: "short" },
	{ text: "Me lembra de ligar pro Carlos às 15h", label: "short" },
	{ text: "Tenta de novo, por favor", label: "short" },
	{ text: "Pode ser, manda ver", label: "short" },
	{ text: "Não entendi, explica de outro jeito?", label: "short" },
	{ text: "O que significa SLA?", label: "short" },
	{ text: "Quem ganhou o jogo ontem?", label: "short" },
	{ text: "Traduz isso pro inglês: obrigado pela ajuda", label: "short" },
	{ text: "what's the capital of Australia?", label: "short" },
	{ text: "thanks, that works", label: "short" },
	{ text: "can you open this link and tell me the title?", label: "short" },
	{ text: "Search for the weather in Curitiba", label: "short" },
	{ text: "Quero uma receita de bolo de cenoura", label: "short" },
	{ text: "Escreve um e-mail curto agradecendo a reunião", label: "short" },
	{ text: "Cria um lembrete pra amanhã de manhã", label: "short" },
	{ text: "Esse site abre pra você? https://example.com", label: "short" },
	{ text: "Tem algum restaurante bom perto da Paulista?", label: "short" },
	{ text: "Já li várias páginas sobre isso, só quero sua opinião: vale a pena?", label: "short" },
	{ text: "Muitas fontes dizem que o café faz mal, você concorda com isso?", label: "short" },
	{ text: "Quantas páginas tem o livro Dom Casmurro?", label: "short" },
];
