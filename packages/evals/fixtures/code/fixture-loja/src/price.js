// Formata um valor em reais para a vitrine da loja: "R$ 1234,50".
export function formatPrice(value) {
	return `R$ ${value.toFixed(2)}`;
}
