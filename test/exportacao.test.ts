import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';

import { prepararCoberturas } from '../src/lib/cobertura.ts';
import { exportarRelatorio } from '../src/lib/relatorio.ts';
import { criarCliente } from '../src/lib/servidor.ts';
import { apagarTemporarios, criar, pastaTemporaria, sonarFalso } from './apoio.ts';

beforeEach(() => {
	mock.method(console, 'log', () => {});
	mock.method(console, 'warn', () => {});
});
after(apagarTemporarios);

describe('exportarRelatorio', () => {
	const issue = (n: number) => ({ component: `p:src/a${n}.ts`, line: n, rule: 'ts:S1', severity: 'MAJOR', type: 'BUG', message: `m${n}` });

	it('pagina as issues, junta as regras de todas as páginas e grava os quatro arquivos', async () => {
		const sonar = await sonarFalso({
			'GET /api/measures/component': () => ({ json: { component: { measures: [{ metric: 'bugs', value: '3' }] } } }),
			'GET /api/qualitygates/project_status': () => ({ json: { projectStatus: { status: 'OK', conditions: [] } } }),
			'GET /api/issues/search': (c) =>
				c.query.get('p') === '1'
					? { json: { issues: [issue(1), issue(2)], rules: [{ key: 'ts:S1', name: 'Regra um' }], paging: { total: 3 } } }
					: { json: { issues: [issue(3)], rules: [{ key: 'ts:S2', name: 'Regra dois' }], paging: { total: 3 } } },
			'GET /api/hotspots/search': () => ({ json: { hotspots: [], paging: { total: 0 } } }),
		});
		const dirSaida = join(pastaTemporaria(), 'saida');
		const dados = await exportarRelatorio(criarCliente(sonar.url, 'x'), { chave: 'p', nome: 'Projeto', dirSaida });
		await sonar.fechar();

		assert.equal(dados.issues.length, 3);
		assert.deepEqual([...dados.regras], [['ts:S1', 'Regra um'], ['ts:S2', 'Regra dois']]);
		assert.equal(dados.gate?.status, 'OK');
		assert.deepEqual(
			sonar.chamadas.filter((c) => c.caminho === '/api/issues/search').map((c) => [c.query.get('components'), c.query.get('ps'), c.query.get('p')]),
			[['p', '500', '1'], ['p', '500', '2']],
		);
		for (const arquivo of ['resumo.md', 'issues.md', 'issues.json', 'hotspots.json']) assert.ok(existsSync(join(dirSaida, arquivo)), arquivo);
		assert.equal(JSON.parse(readFileSync(join(dirSaida, 'issues.json'), 'utf8')).length, 3);
		assert.match(readFileSync(join(dirSaida, 'resumo.md'), 'utf8'), /\| Bugs \| 3 \|/);
	});

	it('falha com a resposta do servidor quando a busca de issues dá erro', async () => {
		const sonar = await sonarFalso({ 'GET /api/issues/search': () => ({ status: 403, texto: 'sem permissão' }) });
		await assert.rejects(
			exportarRelatorio(criarCliente(sonar.url, 'x'), { chave: 'p', nome: 'P', dirSaida: pastaTemporaria() }),
			/Falha em \/api\/issues\/search.* \(403\): sem permissão/,
		);
		await sonar.fechar();
	});
});

describe('prepararCoberturas', () => {
	it('reescreve os lcov achados em coverage/ para dentro da pasta de saída', () => {
		const raiz = pastaTemporaria();
		criar(raiz, 'servidor/src/x.ts');
		criar(raiz, 'servidor/coverage/lcov.info', 'SF:src\\x.ts\nend_of_record');
		const saida = join(raiz, '.sonar-local');
		assert.deepEqual(prepararCoberturas(raiz, saida, {}), ['.sonar-local/lcov-1.info']);
		assert.equal(readFileSync(join(saida, 'lcov-1.info'), 'utf8'), 'SF:servidor/src/x.ts\nend_of_record');
	});

	it('usa só os lcov declarados no properties, avisando dos que não existem', (t) => {
		const avisos = t.mock.method(console, 'warn', () => {});
		const raiz = pastaTemporaria();
		criar(raiz, 'relatorios/lcov.info', 'SF:a.ts');
		criar(raiz, 'outro/coverage/lcov.info', 'SF:b.ts');
		const lcovs = prepararCoberturas(raiz, join(raiz, 'saida'), { 'sonar.javascript.lcov.reportPaths': 'relatorios/lcov.info, falta.info' });
		assert.deepEqual(lcovs, ['saida/lcov-1.info']);
		assert.equal(avisos.mock.callCount(), 1);
		assert.match(String(avisos.mock.calls[0]?.arguments[0]), /lcov declarado não existe: .*falta\.info/);
	});

	it('devolve lista vazia quando não há lcov', () => {
		const raiz = pastaTemporaria();
		assert.deepEqual(prepararCoberturas(raiz, join(raiz, 'saida'), {}), []);
		assert.equal(existsSync(join(raiz, 'saida')), false);
	});
});
