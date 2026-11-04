// O `FormData` do React Native aceita, além de string e Blob, o descritor de arquivo local `{ uri, name, type }`
// (o fetch lê o arquivo e monta a parte do multipart). Os tipos DOM não conhecem essa forma.
export {};

declare global {
	interface FormData {
		append(name: string, value: { uri: string; name: string; type: string }): void;
	}
}
