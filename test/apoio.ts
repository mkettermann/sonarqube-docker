// Apoio aos testes: pastas temporárias e um SonarQube falso (servidor HTTP local que
// responde às rotas da Web API que cada teste simular).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporarios: string[] = [];

export function pastaTemporaria(): string {
	const dir = mkdtempSync(join(tmpdir(), 'sonar-local-'));
	temporarios.push(dir);
	return dir;
}

/** Cria `caminho` (com `/`) dentro de `dir`, com as pastas intermediárias. */
export function criar(dir: string, caminho: string, conteudo = ''): string {
	const alvo = join(dir, ...caminho.split('/'));
	mkdirSync(resolve(alvo, '..'), { recursive: true });
	writeFileSync(alvo, conteudo);
	return alvo;
}

/** Para o `after()` de cada arquivo de teste. */
export function apagarTemporarios(): void {
	for (const d of temporarios.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const basic = (login: string, senha: string): string => 'Basic ' + Buffer.from(`${login}:${senha}`).toString('base64');

export interface Chamada {
	metodo: string;
	caminho: string;
	query: URLSearchParams;
	auth: string | undefined;
	form: Record<string, string>;
}

export interface RespostaFalsa {
	status?: number;
	json?: unknown;
	/** Corpo cru; tem precedência sobre `json`. */
	texto?: string;
}

/** Rotas por `MÉTODO /caminho`, ex.: `'GET /api/system/status'`. Rota não simulada responde 404. */
export type Rotas = Record<string, (chamada: Chamada) => RespostaFalsa>;

export interface SonarFalso {
	url: string;
	chamadas: Chamada[];
	fechar(): Promise<void>;
}

export async function sonarFalso(rotas: Rotas): Promise<SonarFalso> {
	const chamadas: Chamada[] = [];
	const servidor = createServer(async (req, res) => {
		let corpo = '';
		for await (const pedaco of req) corpo += String(pedaco);
		const url = new URL(req.url ?? '/', 'http://localhost');
		const chamada: Chamada = {
			metodo: req.method ?? 'GET',
			caminho: url.pathname,
			query: url.searchParams,
			auth: req.headers.authorization,
			form: Object.fromEntries(new URLSearchParams(corpo)),
		};
		chamadas.push(chamada);
		const rota = rotas[`${chamada.metodo} ${chamada.caminho}`];
		const r = rota ? rota(chamada) : { status: 404, texto: `rota não simulada: ${chamada.metodo} ${chamada.caminho}` };
		res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
		res.end(r.texto ?? (r.json === undefined ? '' : JSON.stringify(r.json)));
	});
	await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
	const { port } = servidor.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		chamadas,
		fechar: () =>
			new Promise<void>((ok) => {
				servidor.closeAllConnections();
				servidor.close(() => ok());
			}),
	};
}
