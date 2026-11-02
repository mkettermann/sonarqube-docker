// Configuração do sonar-local: `.env` deste repositório, `sonar-project.properties`
// do projeto analisado e os argumentos da linha de comando.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz deste repositório (onde estão o docker-compose.yml e o .env). */
export const RAIZ_SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Nomes fixos do docker-compose.yml: o scanner entra na rede e fala com o container pelo nome.
export const REDE = 'sonarqube-local-net';
export const HOST_NA_REDE = 'http://sonarqube-local:9000'; // NOSONAR (S5332): rede interna do Docker, sem TLS
export const VOLUME_CACHE_SCANNER = 'sonarqube-local-scanner-cache';
export const ADMIN_LOGIN = 'admin';
export const SENHA_PADRAO_ADMIN = 'admin';
export const SAIDA_PADRAO = '.sonar-local';

/** Lê um arquivo `CHAVE=valor` (formato do `.env` e do `.properties`), ignorando comentários. */
export function lerChaveValor(conteudo) {
	const mapa = {};
	let pendente = '';
	for (const bruta of conteudo.split(/\r?\n/)) {
		const linha = (pendente + bruta.trim()).trim();
		pendente = '';
		if (!linha || linha.startsWith('#') || linha.startsWith('!')) continue;
		// `.properties` permite continuar o valor na linha seguinte com `\` no fim.
		if (linha.endsWith('\\')) {
			pendente = linha.slice(0, -1);
			continue;
		}
		const i = linha.search(/[=:]/);
		if (i <= 0) continue;
		const chave = linha.slice(0, i).trim();
		let valor = linha.slice(i + 1).trim();
		if (/^(['"]).*\1$/.test(valor)) valor = valor.slice(1, -1);
		mapa[chave] = valor;
	}
	return mapa;
}

function lerArquivoChaveValor(caminho) {
	return existsSync(caminho) ? lerChaveValor(readFileSync(caminho, 'utf8')) : null;
}

/** Variáveis do `.env` deste repositório; as do ambiente do processo têm precedência. */
export function carregarAmbiente(raiz = RAIZ_SERVIDOR, ambiente = process.env) {
	const arquivo = lerArquivoChaveValor(resolve(raiz, '.env')) ?? {};
	const valor = (chave, padrao) => ambiente[chave] || arquivo[chave] || padrao;
	const porta = valor('SONAR_PORT', '9000');
	return {
		temEnv: existsSync(resolve(raiz, '.env')),
		url: valor('SONAR_URL', `http://localhost:${porta}`), // NOSONAR (S5332): localhost, sem TLS
		senhaAdmin: valor('SONAR_ADMIN_PASSWORD', ''),
		imagemScanner: valor('SONAR_SCANNER_IMAGE', 'sonarsource/sonar-scanner-cli:latest'),
	};
}

/** `sonar-project.properties` do projeto analisado, ou `null` se não existir. */
export function lerPropriedadesDoProjeto(dirProjeto) {
	return lerArquivoChaveValor(resolve(dirProjeto, 'sonar-project.properties'));
}

const AJUDA_OPCOES = new Set(['-h', '--help', 'help']);

/**
 * `sonar-local <comando> [--dir X] [--saida Y] [--sem-cobertura] [-- args do scanner]`.
 * Tudo depois de `--` vai intacto para o scanner (ex.: `-- -Dsonar.verbose=true`).
 */
export function lerArgumentos(argv) {
	const opcoes = { comando: 'help', dir: process.cwd(), saida: SAIDA_PADRAO, semCobertura: false, extras: [], posicionais: [] };
	const resto = [...argv];
	if (resto.length && !resto[0].startsWith('-')) opcoes.comando = resto.shift();
	else if (resto.length && !AJUDA_OPCOES.has(resto[0])) opcoes.comando = 'scan';
	while (resto.length) {
		const arg = resto.shift();
		if (arg === '--') {
			opcoes.extras = resto.splice(0);
		} else if (arg === '--dir') {
			opcoes.dir = exigirValor(arg, resto.shift());
		} else if (arg === '--saida') {
			opcoes.saida = exigirValor(arg, resto.shift());
		} else if (arg === '--sem-cobertura') {
			opcoes.semCobertura = true;
		} else if (AJUDA_OPCOES.has(arg)) {
			opcoes.comando = 'help';
		} else if (arg.startsWith('-')) {
			throw new Error(`Opção desconhecida: ${arg} (veja \`sonar-local help\`).`);
		} else {
			opcoes.posicionais.push(arg);
		}
	}
	opcoes.dir = resolve(opcoes.dir);
	opcoes.saida = resolve(opcoes.dir, opcoes.saida);
	return opcoes;
}

function exigirValor(opcao, valor) {
	if (!valor || valor.startsWith('-')) throw new Error(`A opção ${opcao} precisa de um valor.`);
	return valor;
}

/** Caminho relativo à raiz do projeto com `/`, ou `null` se estiver fora dela. */
export function relativoAoProjeto(dirProjeto, caminho) {
	const rel = relative(dirProjeto, caminho);
	if (rel.startsWith('..') || isAbsolute(rel)) return null;
	return rel.replaceAll('\\', '/');
}
