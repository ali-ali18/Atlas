import assert from "node:assert/strict";
import test from "node:test";
import { hoverRevealClass, type HoverRevealGroup } from "./hover-reveal";

test("ação de hover fica visível e discreta em tela de toque, sem perder o hover no desktop", () => {
	for (const group of ["message", "trigger", "group"] as HoverRevealGroup[]) {
		const classes = hoverRevealClass(group).split(" ");
		assert.ok(classes.includes("opacity-0"), `${group}: escondida por padrão`);
		assert.ok(classes.includes("[@media(hover:none)]:opacity-60"), `${group}: visível no toque`);
		assert.ok(classes.some((item) => item.startsWith("group-hover") && item.endsWith(":opacity-100")), `${group}: revela no hover`);
		assert.ok(classes.includes("focus-visible:opacity-100"), `${group}: revela no foco`);
	}
});

test("cada grupo usa o seu próprio nome de group", () => {
	assert.match(hoverRevealClass("message"), /group-hover\/message:/);
	assert.match(hoverRevealClass("trigger"), /group-hover\/trigger:/);
});
