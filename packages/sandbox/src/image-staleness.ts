/** Decide se o container de uma conversa deve ser recriado porque a imagem
 * da sandbox mudou (rebuild de `atlas-agent-sandbox:latest`). Pura: se algum
 * dos IDs é desconhecido, mantém o container (nunca recria no escuro). */
export function shouldRecreateForImage(
	containerImageId: string | null | undefined,
	currentImageId: string | null | undefined,
): boolean {
	const a = containerImageId?.trim();
	const b = currentImageId?.trim();
	if (!a || !b) return false;
	return a !== b;
}
