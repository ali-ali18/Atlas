/**
 * Registro dos idiomas suportados. Idioma novo = UMA entrada aqui (nome para o modelo, palavras-função para a
 * detecção e sinais de grafia) mais as mensagens em `system-messages.ts` (o compilador cobra). O resto
 * (`BOT_LANGUAGES`, instrução, detecção, normalização de locale) deriva deste objeto.
 */
export type LanguageSpec = {
	/** Nome em inglês usado nas instruções ao modelo. */
	name: string;
	/**
	 * Palavras-função frequentes (minúsculas, sem acento opcional). A detecção ignora as que aparecem em mais de um
	 * idioma, então liste à vontade: só as que distinguem contam.
	 */
	words: readonly string[];
	/** Letras/sinais característicos da grafia (cada palavra que tem um conta como indício). */
	cues: string;
};

export const LANGUAGE_SPECS = {
	"pt-BR": {
		name: "Brazilian Portuguese",
		words: [
			"o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas", "para", "pra", "por", "pelo", "pela",
			"com", "sem", "sobre", "entre", "até", "que", "se", "mas", "porque", "pois", "como", "quando", "onde", "quem", "qual", "quais", "quanto", "quanta",
			"eu", "você", "voce", "vocês", "ele", "ela", "eles", "elas", "nós", "nos", "meu", "minha", "meus", "minhas", "seu", "sua", "seus", "suas", "isso", "isto",
			"esse", "essa", "esses", "essas", "este", "esta", "aquele", "aquela", "não", "nao", "sim", "muito", "muita", "mais", "menos", "também", "tambem", "já",
			"ainda", "agora", "hoje", "amanhã", "ontem", "aqui", "ali", "bom", "boa", "dia", "tarde", "noite", "obrigado", "obrigada", "favor",
			"quero", "preciso", "pode", "poderia", "consegue", "faça", "faz", "fazer", "tenho", "tem", "tinha", "está", "estou", "estão", "são", "sou", "foi", "vai",
			"vou", "vamos", "me", "te", "lhe", "mim", "ver", "mostre", "mande", "manda", "olá", "ola", "tudo", "todos", "todas", "cada", "outro", "outra", "então",
			"entao", "só", "mesmo", "pelo", "depois", "antes", "sempre", "nunca", "algum", "alguma", "nenhum", "seria", "gostaria", "ótimo", "otimo", "beleza",
		],
		cues: "ãõç",
	},
	"en-US": {
		name: "American English",
		words: [
			"the", "a", "an", "of", "to", "in", "on", "at", "by", "for", "with", "without", "about", "between", "from", "into", "over", "under", "and", "or", "but",
			"because", "if", "when", "where", "who", "whom", "which", "what", "why", "how", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
			"them", "my", "your", "his", "its", "our", "their", "this", "that", "these", "those", "is", "are", "was", "were", "be", "been", "am", "do", "does", "did",
			"have", "has", "had", "will", "would", "can", "could", "should", "shall", "may", "might", "must", "not", "no", "yes", "very", "more", "less", "also",
			"already", "still", "now", "today", "tomorrow", "yesterday", "here", "there", "good", "morning", "afternoon", "evening", "night", "thanks", "thank",
			"please", "want", "need", "make", "show", "send", "tell", "give", "get", "let", "just", "some", "any", "all", "each", "other", "then", "than", "so",
			"hello", "hi", "hey", "check", "remind", "every", "week", "month", "again", "after", "before", "always", "never", "something", "anything", "i'm",
			"it's", "don't", "can't", "i'll", "i've", "what's", "let's", "doesn't", "isn't", "won't",
		],
		cues: "",
	},
	"es-ES": {
		name: "European Spanish",
		words: [
			"el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "en", "con", "sin", "sobre", "entre", "hasta", "desde", "para", "por", "y", "o",
			"pero", "porque", "pues", "como", "cuando", "donde", "dónde", "quien", "quién", "cual", "cuál", "cuanto", "cuánto", "que", "qué", "yo", "tú", "usted",
			"ustedes", "él", "ella", "ellos", "ellas", "nosotros", "vosotros", "mi", "mis", "tu", "tus", "su", "sus", "nuestro", "esto", "eso", "ese", "esa", "esos",
			"esas", "este", "esta", "estos", "estas", "aquel", "aquella", "no", "sí", "si", "muy", "mucho", "mucha", "más", "menos", "también", "tambien", "ya",
			"todavía", "todavia", "ahora", "hoy", "mañana", "ayer", "aquí", "aqui", "allí", "ahí", "buen", "bueno", "buena", "buenos", "buenas", "día", "dias",
			"días", "tarde", "tardes", "noche", "noches", "gracias", "favor", "quiero", "necesito", "puedes", "puede", "podrías", "podrias", "haz", "hacer", "tengo",
			"tiene", "tenía", "está", "estoy", "están", "son", "soy", "fue", "va", "voy", "vamos", "me", "te", "le", "les", "se", "lo", "ver", "muestra", "envía",
			"hola", "todo", "todos", "todas", "cada", "otro", "otra", "entonces", "solo", "sólo", "mismo", "después", "despues", "antes", "siempre", "nunca",
			"algún", "alguna", "ningún", "sería", "gustaría", "vale", "genial", "recuérdame", "recuerdame",
		],
		cues: "ñ¿¡",
	},
} as const satisfies Record<string, LanguageSpec>;
