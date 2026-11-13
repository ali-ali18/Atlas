// Porta `Random`: bytes aleatórios injetados. O núcleo não chama Math.random nem
// `crypto` direto: o adaptador usa o CSPRNG do sistema, o teste usa uma fonte fixa.

export interface Random {
	/** `length` bytes imprevisíveis (CSPRNG no adaptador real). */
	bytes(length: number): Uint8Array;
}
