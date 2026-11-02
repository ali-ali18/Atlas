// Navegação da gaveta de ações (`components/ui/action-sheet.tsx`): a raiz mais as subpáginas abertas ("Mover para", "Mais").
// Só lógica pura; o componente guarda a pilha em estado.

/** Página da gaveta: título (só nas subpáginas) e as ações. Genérica no tipo da ação para não depender de React aqui. */
export type SheetPage<A> = { title?: string; groups: A[][] };

/** Subpáginas abertas, da mais antiga para a mais nova. Vazia = está na raiz. */
export type SheetStack<A> = readonly SheetPage<A>[];

/** Abre uma subpágina por cima da atual. */
export function openSubmenu<A>(stack: SheetStack<A>, page: SheetPage<A>): SheetStack<A> {
	return [...stack, page];
}

/** Volta uma página (na raiz não faz nada). */
export function goBack<A>(stack: SheetStack<A>): SheetStack<A> {
	return stack.slice(0, -1);
}

/** A página que está na tela: a última aberta, ou a raiz. */
export function currentPage<A>(root: SheetPage<A>, stack: SheetStack<A>): SheetPage<A> {
	return stack[stack.length - 1] ?? root;
}

/** Tem para onde voltar? (o botão "voltar" só aparece nas subpáginas) */
export function canGoBack<A>(stack: SheetStack<A>): boolean {
	return stack.length > 0;
}

/** Ação que abre subpágina em vez de executar: a subpágina ganha o rótulo da ação como título se não tiver um. */
export function submenuPage<A>(label: string, submenu: SheetPage<A>): SheetPage<A> {
	return submenu.title ? submenu : { ...submenu, title: label };
}
