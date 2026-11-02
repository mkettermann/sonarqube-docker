// Conversa com o SonarQube pela Web API: espera subir, garante a senha do admin,
// o projeto e o token de análise, e acompanha o processamento.

import { spawn } from 'node:child_process';

import { ADMIN_LOGIN, RAIZ_SERVIDOR, SENHA_PADRAO_ADMIN } from './config.ts';

export const esperar = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

function basic(login: string, senha: string): string {
	return 'Basic ' + Buffer.from(`${login}:${senha}`).toString('base64');
}

export interface OpcoesDeChamada {
	metodo?: 'GET' | 'POST';
	/** Cabeçalho `Authorization`; `null` chama sem autenticação. Padrão: admin + senha do `.env`. */
	auth?: string | null;
	form?: Record<string, string>;
}

/** Resposta da Web API; `json` é `null` se o corpo vier vazio ou não for JSON. */
export interface Resposta<T> {
	status: number;
	json: T | null;
	texto: string;
}

export interface Cliente {
	url: string;
	senhaAdmin: string;
	/** `T` é o formato esperado do JSON — não é validado, só documenta o que a API devolve. */
	chamar<T = unknown>(caminho: string, opcoes?: OpcoesDeChamada): Promise<Resposta<T>>;
}

interface RespostaComToken {
	token?: string;
}

export function criarCliente(url: string, senhaAdmin: string): Cliente {
	async function chamar<T>(caminho: string, { metodo = 'GET', auth = basic(ADMIN_LOGIN, senhaAdmin), form }: OpcoesDeChamada = {}): Promise<Resposta<T>> {
		const headers: Record<string, string> = {};
		if (auth) headers.Authorization = auth;
		let body: string | undefined;
		if (form) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			body = new URLSearchParams(form).toString();
		}
		const res = await fetch(url + caminho, { method: metodo, headers, body: body ?? null });
		const texto = await res.text();
		let json: T | null = null;
		try {
			json = texto ? (JSON.parse(texto) as T) : null;
		} catch {
			json = null;
		}
		return { status: res.status, json, texto };
	}
	return { url, senhaAdmin, chamar };
}

/** Status do servidor (`UP`, `STARTING`, `DB_MIGRATION_NEEDED`…) ou `null` se não responde. */
export async function statusDoServidor(cliente: Cliente): Promise<string | null> {
	try {
		const { json } = await cliente.chamar<{ status?: string }>('/api/system/status', { auth: null });
		return json?.status ?? null;
	} catch {
		return null;
	}
}

/** Roda `docker compose` na pasta deste repositório. */
export function compose(args: string[]): Promise<void> {
	return executar('docker', ['compose', ...args], { cwd: RAIZ_SERVIDOR });
}

export interface OpcoesDeExecucao {
	cwd?: string;
	/** Recebe cada pedaço do stdout (que continua sendo repassado ao terminal). */
	aoLerSaida?: (texto: string) => void;
}

export function executar(comando: string, args: string[], { cwd, aoLerSaida }: OpcoesDeExecucao = {}): Promise<void> {
	return new Promise((ok, falha) => {
		// NOSONAR (S4036): ferramenta de dev — o `docker` do PATH de quem a roda é o esperado.
		const filho = spawn(comando, args, { cwd, stdio: ['ignore', aoLerSaida ? 'pipe' : 'inherit', 'inherit'] }); // NOSONAR
		if (aoLerSaida) {
			filho.stdout?.on('data', (pedaco: Buffer) => {
				const texto = pedaco.toString();
				process.stdout.write(texto);
				aoLerSaida(texto);
			});
		}
		filho.on('error', (e: NodeJS.ErrnoException) => falha(e.code === 'ENOENT' ? new Error(`\`${comando}\` não encontrado no PATH.`) : e));
		filho.on('close', (codigo) => (codigo === 0 ? ok() : falha(new Error(`\`${comando} ${args[0]}\` terminou com código ${codigo}.`))));
	});
}

/**
 * Garante o servidor `UP`. Se não responde, sobe o docker-compose deste repositório —
 * assim um projeto pode rodar `sonar-local scan` sem lembrar de subir nada antes.
 * O primeiro start leva ~1-2 min (Elasticsearch + criação do banco).
 */
export async function garantirServidor(cliente: Cliente, { timeoutMs = 300_000 } = {}): Promise<void> {
	const inicial = await statusDoServidor(cliente);
	if (inicial === 'UP') return;
	if (inicial === null) {
		console.log(`[sonar] servidor não responde em ${cliente.url} — subindo o docker compose de ${RAIZ_SERVIDOR}…`);
		await compose(['up', '-d']);
	}
	const fim = Date.now() + timeoutMs;
	let ultimo = '';
	while (Date.now() < fim) {
		const status = await statusDoServidor(cliente);
		if (status === 'UP') return;
		if (status === 'DB_MIGRATION_NEEDED') {
			throw new Error(`O SonarQube foi atualizado e precisa migrar o banco: abra ${cliente.url}/setup (ver docs/operacao.md).`);
		}
		if (status && status !== ultimo) {
			ultimo = status;
			console.log(`[sonar] status: ${status}`);
		}
		await esperar(3000);
	}
	throw new Error(`SonarQube não ficou UP em ${timeoutMs / 1000}s (${cliente.url}). Veja \`docker compose logs sonarqube\` em ${RAIZ_SERVIDOR}.`);
}

async function credencialValida(cliente: Cliente, senha: string): Promise<boolean> {
	const { json } = await cliente.chamar<{ valid?: boolean }>('/api/authentication/validate', { auth: basic(ADMIN_LOGIN, senha) });
	return json?.valid === true;
}

/**
 * O Sonar obriga trocar o `admin`/`admin` no primeiro login, e nenhuma chamada autenticada
 * passa antes disso: troca pela senha do `.env` na primeira execução.
 */
export async function garantirSenhaAdmin(cliente: Cliente): Promise<void> {
	if (!cliente.senhaAdmin) {
		throw new Error(`SONAR_ADMIN_PASSWORD vazio: copie .env.example para .env em ${RAIZ_SERVIDOR} e defina a senha.`);
	}
	if (await credencialValida(cliente, cliente.senhaAdmin)) return;
	if (!(await credencialValida(cliente, SENHA_PADRAO_ADMIN))) {
		throw new Error(
			'A senha do admin no .env não confere com a do servidor (e a padrão também não). ' +
				'Corrija SONAR_ADMIN_PASSWORD no .env ou troque a senha pelo painel (ver docs/operacao.md).',
		);
	}
	const r = await cliente.chamar('/api/users/change_password', {
		metodo: 'POST',
		auth: basic(ADMIN_LOGIN, SENHA_PADRAO_ADMIN),
		form: { login: ADMIN_LOGIN, previousPassword: SENHA_PADRAO_ADMIN, password: cliente.senhaAdmin },
	});
	if (r.status >= 300) throw new Error(`Falha ao trocar a senha do admin (${r.status}): ${r.texto}`);
	console.log('[sonar] senha padrão do admin trocada pela do .env.');
}

export async function garantirProjeto(cliente: Cliente, chave: string, nome: string): Promise<void> {
	const { json } = await cliente.chamar<{ components?: { key: string }[] }>(`/api/projects/search?projects=${encodeURIComponent(chave)}`);
	if (json?.components?.some((c) => c.key === chave)) return;
	const r = await cliente.chamar('/api/projects/create', { metodo: 'POST', form: { project: chave, name: nome } });
	if (r.status >= 300) throw new Error(`Falha ao criar o projeto ${chave} (${r.status}): ${r.texto}`);
	console.log(`[sonar] projeto ${chave} criado.`);
}

/** Token de análise restrito ao projeto; o da execução anterior é revogado. */
export async function emitirTokenDeAnalise(cliente: Cliente, chave: string): Promise<string> {
	const nome = `sonar-local-scan-${chave}`;
	await cliente.chamar('/api/user_tokens/revoke', { metodo: 'POST', form: { name: nome } });
	const r = await cliente.chamar<RespostaComToken>('/api/user_tokens/generate', {
		metodo: 'POST',
		form: { name: nome, type: 'PROJECT_ANALYSIS_TOKEN', projectKey: chave },
	});
	if (!r.json?.token) throw new Error(`Falha ao gerar o token de análise (${r.status}): ${r.texto}`);
	return r.json.token;
}

/** Token de usuário (ex.: para o SonarQube for IDE em modo conectado). */
export async function emitirTokenDeUsuario(cliente: Cliente, nome: string): Promise<string> {
	const r = await cliente.chamar<RespostaComToken>('/api/user_tokens/generate', { metodo: 'POST', form: { name: nome, type: 'USER_TOKEN' } });
	if (!r.json?.token) throw new Error(`Falha ao gerar o token (${r.status}): ${r.texto}`);
	return r.json.token;
}

interface RespostaDaTarefa {
	task?: { status?: string; errorMessage?: string };
}

export async function aguardarProcessamento(cliente: Cliente, idTarefa: string | undefined, { timeoutMs = 1_800_000 } = {}): Promise<void> {
	if (!idTarefa) {
		console.warn('[sonar] id da tarefa não encontrado na saída do scanner — o relatório pode sair desatualizado.');
		return;
	}
	console.log('[sonar] aguardando o servidor processar a análise…');
	const fim = Date.now() + timeoutMs;
	while (Date.now() < fim) {
		const { status: http, json, texto } = await cliente.chamar<RespostaDaTarefa>(`/api/ce/task?id=${idTarefa}`);
		if (http >= 300) throw new Error(`Falha ao consultar a tarefa ${idTarefa} (${http}): ${texto}`);
		const status = json?.task?.status;
		if (status === 'SUCCESS') return;
		if (status === 'FAILED' || status === 'CANCELED') {
			throw new Error(`Processamento da análise: ${status} — ${json?.task?.errorMessage ?? ''}`);
		}
		await esperar(3000);
	}
	throw new Error(`A tarefa ${idTarefa} não terminou em ${timeoutMs / 60_000} min.`);
}
