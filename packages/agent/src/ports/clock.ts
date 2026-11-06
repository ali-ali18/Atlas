// Porta `Clock`: o tempo entra injetado; nada de relógio real na lógica,
// para testar datas e atrasos sem depender do dia em que o teste roda.

export interface Clock {
	now(): Date;
}
