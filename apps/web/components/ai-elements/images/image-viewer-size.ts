/** Ajusta à área livre sem ampliar a imagem original; o zoom é aplicado depois. */
export function fitImageSize(width: number, height: number, availableWidth: number, availableHeight: number) {
	if (![width, height, availableWidth, availableHeight].every((value) => Number.isFinite(value) && value > 0)) {
		return { width: 0, height: 0 };
	}
	const ratio = Math.min(1, availableWidth / width, availableHeight / height);
	return { width: width * ratio, height: height * ratio };
}
