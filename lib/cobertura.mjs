// Cobertura em LCOV (JS/TS): acha os `lcov.info` do projeto e reescreve os caminhos
// para relativos à RAIZ do projeto, que é como o scanner (no container, com o projeto
// em /usr/src) os enxerga.
//
// ⚠️ Sem a reescrita a cobertura chega ZERADA ao Sonar sem erro nenhum — só um aviso
// no meio do log: os geradores gravam `SF:` relativo ao PACOTE (`SF:src\api\x.ts`,
// com `\` no Windows) ou absoluto do Windows (`SF:C:\...`), e nenhum dos dois casa
// com arquivo nenhum dentro do container.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { relativoAoProjeto } from './config.mjs';

const PASTAS_IGNORADAS = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target']);
const PROFUNDIDADE_MAXIMA = 6;

/** Procura `lcov.info` dentro de pastas `coverage/`, sem entrar em node_modules nem pastas ocultas. */
export function descobrirLcovs(dirProjeto) {
	const achados = [];
	const visitar = (dir, profundidade, dentroDeCoverage) => {
		if (profundidade > PROFUNDIDADE_MAXIMA) return;
		let entradas;
		try {
			entradas = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entradas) {
			if (e.isDirectory()) {
				if (e.name.startsWith('.') || PASTAS_IGNORADAS.has(e.name)) continue;
				visitar(join(dir, e.name), profundidade + 1, dentroDeCoverage || e.name === 'coverage');
			} else if (dentroDeCoverage && e.name === 'lcov.info') {
				achados.push(join(dir, e.name));
			}
		}
	};
	visitar(dirProjeto, 0, false);
	return achados.sort((a, b) => a.localeCompare(b));
}

/**
 * Reescreve as linhas `SF:` de um lcov para caminhos relativos à raiz do projeto (com `/`).
 * Caminho relativo: procurado subindo da pasta do lcov até a raiz (o primeiro onde o
 * arquivo existe é o pacote dono). Não achou: fica como está.
 */
export function reescreverLcov(conteudo, arquivoLcov, dirProjeto, existe = existsSync) {
	return conteudo
		.split(/\r?\n/)
		.map((linha) => {
			if (!linha.startsWith('SF:')) return linha;
			const original = linha.slice(3).trim();
			const absoluto = isAbsolute(original) || /^[A-Za-z]:[\\/]/.test(original);
			const alvo = absoluto ? original : localizarRelativo(original.replaceAll('\\', '/'), dirname(arquivoLcov), dirProjeto, existe);
			const rel = alvo ? relativoAoProjeto(dirProjeto, alvo) : null;
			return 'SF:' + (rel ?? original.replaceAll('\\', '/'));
		})
		.join('\n');
}

function localizarRelativo(caminho, dirInicial, dirProjeto, existe) {
	let dir = dirInicial;
	for (;;) {
		const candidato = resolve(dir, caminho);
		if (existe(candidato)) return candidato;
		if (relative(dirProjeto, dir) === '' || dir === dirname(dir)) return null;
		dir = dirname(dir);
	}
}

/**
 * Prepara os lcov para o scanner e devolve os caminhos (relativos ao projeto) das cópias
 * reescritas. Fonte: `sonar.javascript.lcov.reportPaths` do properties, se houver; senão,
 * os `lcov.info` encontrados em `coverage/`.
 */
export function prepararCoberturas(dirProjeto, dirSaida, propriedades) {
	const declarados = (propriedades['sonar.javascript.lcov.reportPaths'] ?? '')
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => resolve(dirProjeto, p));
	const origens = declarados.length ? declarados.filter((p) => existsSync(p)) : descobrirLcovs(dirProjeto);
	for (const faltando of declarados.filter((p) => !existsSync(p))) {
		console.warn(`[sonar] lcov declarado não existe: ${faltando}`);
	}
	if (!origens.length) {
		console.log('[sonar] nenhum lcov.info encontrado — análise sem cobertura de JS/TS (rode os testes com cobertura antes, se quiser).');
		return [];
	}
	mkdirSync(dirSaida, { recursive: true });
	return origens.map((origem, i) => {
		const destino = join(dirSaida, `lcov-${i + 1}.info`);
		writeFileSync(destino, reescreverLcov(readFileSync(origem, 'utf8'), origem, dirProjeto));
		const rel = relativoAoProjeto(dirProjeto, destino);
		console.log(`[sonar] cobertura: ${relativoAoProjeto(dirProjeto, origem)} → ${rel}`);
		return rel;
	});
}
