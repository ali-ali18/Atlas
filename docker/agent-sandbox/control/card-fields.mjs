// Seletores dos campos de cartão: UMA definição para o driver do `card_fill` (que preenche) e para as leituras da página
// (mapa, partes, busca, árvore de acessibilidade, ações), que tratam esses mesmos campos como SEGREDO: o valor digitado nunca
// sai da VM. Mudou um seletor aqui, mudou nos dois lados.

export const NUMBER = [
	'input[autocomplete="cc-number"]', 'input[name="cardnumber" i]', 'input[name="card-number" i]', 'input[name="card_number" i]', 'input[name="cardNumber"]',
	'input[data-elements-stable-field-name="cardNumber"]', 'input[id*="card" i][id*="num" i]', 'input[name*="card" i][name*="num" i]',
	'input[placeholder*="card number" i]', 'input[placeholder*="número do cartão" i]', 'input[placeholder*="numero do cartao" i]',
];
export const EXP = [
	'input[autocomplete="cc-exp"]', 'input[name="exp-date" i]', 'input[name="expiry" i]', 'input[name="expdate" i]', 'input[name*="exp" i][name*="date" i]',
	'input[data-elements-stable-field-name="cardExpiry"]', 'input[placeholder*="MM" i][placeholder*="YY" i]', 'input[placeholder*="MM" i][placeholder*="AA" i]', 'input[placeholder*="validade" i]',
];
export const EXP_MONTH = ['input[autocomplete="cc-exp-month"]', 'select[autocomplete="cc-exp-month"]', 'input[name*="exp" i][name*="month" i]', 'select[name*="exp" i][name*="month" i]'];
export const EXP_YEAR = ['input[autocomplete="cc-exp-year"]', 'select[autocomplete="cc-exp-year"]', 'input[name*="exp" i][name*="year" i]', 'select[name*="exp" i][name*="year" i]'];
export const CVV = [
	'input[autocomplete="cc-csc"]', 'input[name="cvc" i]', 'input[name="cvv" i]', 'input[name="cvc2" i]', 'input[name*="security" i][name*="code" i]',
	'input[data-elements-stable-field-name="cardCvc"]', 'input[id*="cvv" i]', 'input[id*="cvc" i]', 'input[placeholder*="CVV" i]', 'input[placeholder*="CVC" i]', 'input[placeholder*="código de segurança" i]',
];
export const HOLDER = ['input[autocomplete="cc-name"]', 'input[name*="holder" i]', 'input[name="ccname" i]', 'input[name*="name" i][name*="card" i]', 'input[placeholder*="name on card" i]', 'input[placeholder*="nome no cartão" i]', 'input[placeholder*="nome impresso" i]'];

/** Todo campo que guarda dado do cartão (número, validade, CVV, titular): valor nunca exposto. Só leitura estrutural (CSS). */
export const CARD_SECRET_SELECTOR = [
	'input[autocomplete^="cc-" i]',
	'select[autocomplete^="cc-" i]',
	// Campo que o driver do card_fill marcou com autocomplete="off" (o Chrome não grava o valor no estado de sessão): perde o
	// `autocomplete="cc-*"`, então este marcador mantém todas as leituras da página tratando-o como segredo.
	"[data-atlas-cc]",
	...NUMBER,
	...EXP,
	...EXP_MONTH,
	...EXP_YEAR,
	...CVV,
	...HOLDER,
].join(",");
