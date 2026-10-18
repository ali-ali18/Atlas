export type GroupPosition = "single" | "first" | "middle" | "last";

/**
 * Cantos no estilo "conectado" (Instagram): a ponta onde a bolha encosta na
 * vizinha do mesmo autor fica com raio pequeno; as demais ficam arredondadas.
 */
export function bubbleRadius(
	side: "left" | "right",
	position: GroupPosition,
): string {
	if (position === "single") {
		return "rounded-2xl";
	}

	if (side === "left") {
		switch (position) {
			case "first":
				return "rounded-tl-2xl rounded-tr-2xl rounded-br-2xl rounded-bl-md";
			case "middle":
				return "rounded-tl-md rounded-tr-2xl rounded-br-2xl rounded-bl-md";
			case "last":
				return "rounded-tl-md rounded-tr-2xl rounded-br-2xl rounded-bl-2xl";
			default:
				return "rounded-2xl";
		}
	}

	switch (position) {
		case "first":
			return "rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl rounded-br-md";
		case "middle":
			return "rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-md";
		case "last":
			return "rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl";
		default:
			return "rounded-2xl";
	}
}
