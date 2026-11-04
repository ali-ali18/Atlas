// Quando o viewer da VM pode existir. A WebView do Android desenha numa camada própria que vaza por cima das telas
// empilhadas depois (a tela do Computador continua montada embaixo no Stack), e o WebSocket ficaria aberto em segundo
// plano. Por isso o viewer só existe com a tela em FOCO e o app ATIVO; fora disso desmonta e cancela tudo, e ao voltar
// reconecta do zero (passa pela esfera "Conectando").

/** `focused`: a tela do Computador é a do topo da pilha. `appState`: o `AppState.currentState` do React Native. */
export function viewerActive(focused: boolean, appState: string): boolean {
	return focused && appState === "active";
}
