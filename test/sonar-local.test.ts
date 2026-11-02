import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { descobrirLcovs, reescreverLcov } from '../src/lib/cobertura.ts';
import { carregarAmbiente, lerArgumentos, lerChaveValor, relativoAoProjeto } from '../src/lib/config.ts';
import { type DadosDoRelatorio, type Issue, montarListaDeIssues, montarResumo } from '../src/lib/relatorio.ts';
import { argumentosDoScanner, idDaTarefa } from '../src/lib/scanner.ts';

const temporarios: string[] = [];
function pastaTemporaria(): string {
	const dir = mkdtempSync(join(tmpdir(), 'sonar-local-'));
	temporarios.push(dir);
	return dir;
}
function criar(dir: string, caminho: string, conteudo = ''): string {
	const alvo = join(dir, ...caminho.split('/'));
	mkdirSync(resolve(alvo, '..'), { recursive: true });
	writeFileSync(alvo, conteudo);
	return alvo;
}
after(() => temporarios.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('lerChaveValor', () => {
	it('lê .env e .properties, ignorando comentários e aspas', () => {
		const mapa = lerChaveValor(['# comentário', '! outro', '', 'A=1', 'B = "dois"', "C='3'", 'sonar.x=**/*', 'URL=http://h:9000'].join('\r\n'));
		assert.deepEqual(mapa, { A: '1', B: 'dois', C: '3', 'sonar.x': '**/*', URL: 'http://h:9000' });
	});

	it('junta valores continuados com `\\` no fim da linha', () => {
		assert.deepEqual(lerChaveValor('sonar.sources=a,\\\n  b,\\\n  c\nX=1'), { 'sonar.sources': 'a,b,c', X: '1' });
	});
});

describe('carregarAmbiente', () => {
	it('monta a URL pela porta do .env e dá precedência ao ambiente do processo', () => {
		const dir = pastaTemporaria();
		criar(dir, '.env', 'SONAR_PORT=9100\nSONAR_ADMIN_PASSWORD=Do.Env.123456\n');
		assert.equal(carregarAmbiente(dir, {}).url, 'http://localhost:9100');
		assert.equal(carregarAmbiente(dir, {}).senhaAdmin, 'Do.Env.123456');
		assert.equal(carregarAmbiente(dir, { SONAR_ADMIN_PASSWORD: 'Do.Processo.1' }).senhaAdmin, 'Do.Processo.1');
	});
});

describe('lerArgumentos', () => {
	it('separa comando, opções e os argumentos extras do scanner', () => {
		const o = lerArgumentos(['scan', '--dir', 'x', '--saida', 'temp/sonar', '--sem-cobertura', '--', '-Dsonar.verbose=true']);
		assert.equal(o.comando, 'scan');
		assert.equal(o.dir, resolve('x'));
		assert.equal(o.saida, resolve('x', 'temp/sonar'));
		assert.equal(o.semCobertura, true);
		assert.deepEqual(o.extras, ['-Dsonar.verbose=true']);
	});

	it('assume `scan` quando só há opções, e `help` sem nada', () => {
		assert.equal(lerArgumentos(['--sem-cobertura']).comando, 'scan');
		assert.equal(lerArgumentos([]).comando, 'help');
		assert.equal(lerArgumentos(['--help']).comando, 'help');
	});

	it('recusa opção desconhecida ou sem valor', () => {
		assert.throws(() => lerArgumentos(['scan', '--xyz']), /desconhecida/);
		assert.throws(() => lerArgumentos(['scan', '--dir']), /precisa de um valor/);
	});
});

describe('relativoAoProjeto', () => {
	it('devolve caminho com / dentro do projeto e null fora dele', () => {
		const raiz = resolve('projeto');
		assert.equal(relativoAoProjeto(raiz, join(raiz, 'a', 'b.ts')), 'a/b.ts');
		assert.equal(relativoAoProjeto(raiz, resolve('outro', 'b.ts')), null);
	});
});

describe('reescreverLcov', () => {
	it('acha o pacote dono de um SF relativo subindo a partir da pasta do lcov', () => {
		const raiz = pastaTemporaria();
		criar(raiz, 'servidor/src/api/x.ts');
		const lcov = criar(raiz, 'servidor/coverage/lcov.info');
		const saida = reescreverLcov('TN:\nSF:src\\api\\x.ts\nDA:1,1\nend_of_record\r\nSF:src/api/x.ts', lcov, raiz);
		assert.equal(saida, 'TN:\nSF:servidor/src/api/x.ts\nDA:1,1\nend_of_record\nSF:servidor/src/api/x.ts');
	});

	it('torna relativo um SF absoluto dentro do projeto', () => {
		const raiz = pastaTemporaria();
		const fonte = criar(raiz, 'cliente/src/app.ts');
		const lcov = criar(raiz, 'cliente/coverage/App/lcov.info');
		assert.equal(reescreverLcov(`SF:${fonte}`, lcov, raiz), 'SF:cliente/src/app.ts');
	});

	it('mantém (com /) o SF que não casa com arquivo nenhum', () => {
		const raiz = pastaTemporaria();
		const lcov = criar(raiz, 'coverage/lcov.info');
		assert.equal(reescreverLcov('SF:src\\sumiu.ts', lcov, raiz), 'SF:src/sumiu.ts');
	});
});

describe('descobrirLcovs', () => {
	it('acha lcov.info dentro de coverage/, sem entrar em node_modules nem pastas ocultas', () => {
		const raiz = pastaTemporaria();
		const a = criar(raiz, 'servidor/coverage/lcov.info');
		const b = criar(raiz, 'cliente/coverage/App/lcov.info');
		criar(raiz, 'node_modules/pkg/coverage/lcov.info');
		criar(raiz, '.sonar-local/coverage/lcov.info');
		criar(raiz, 'lcov.info');
		assert.deepEqual(descobrirLcovs(raiz), [b, a]);
	});
});

describe('scanner', () => {
	it('lê o id da tarefa da saída do scanner', () => {
		const saida = 'INFO  More about the report processing at http://sonarqube-local:9000/api/ce/task?id=AZn-a1_b2\n';
		assert.equal(idDaTarefa(saida), 'AZn-a1_b2');
		assert.equal(idDaTarefa('nada aqui'), undefined);
	});

	it('monta o docker run na rede do servidor, com lcov e extras no fim', () => {
		const args = argumentosDoScanner({ dirProjeto: 'C:\\p', token: 'tk', imagem: 'img', lcovs: ['.sonar-local/lcov-1.info'], extras: ['-X'] });
		assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--network', 'sonarqube-local-net']);
		assert.ok(args.includes('C:\\p:/usr/src'));
		assert.ok(args.includes('SONAR_TOKEN=tk'));
		assert.deepEqual(args.slice(-3), ['img', '-Dsonar.javascript.lcov.reportPaths=.sonar-local/lcov-1.info', '-X']);
	});
});

describe('relatório', () => {
	const issue = (component: string, line: number, rule: string, severity = 'MAJOR'): Issue => ({ component: `p:${component}`, line, rule, severity, type: 'CODE_SMELL', message: `msg ${rule}` });
	const dados: DadosDoRelatorio = {
		chave: 'p',
		nome: 'Projeto',
		url: 'http://localhost:9000',
		medidas: [
			{ metric: 'sqale_rating', value: '4.0' },
			{ metric: 'bugs', value: '0' },
		],
		gate: { status: 'ERROR', conditions: [{ status: 'ERROR', metricKey: 'new_coverage', actualValue: '10', comparator: 'LT', errorThreshold: '80' }] },
		issues: [issue('a.ts', 9, 'ts:S2'), issue('b.ts', 3, 'ts:S1', 'BLOCKER'), issue('a.ts', 2, 'ts:S1')],
		hotspots: [{ component: 'p:c.ts', line: 7, vulnerabilityProbability: 'HIGH', ruleKey: 'ts:S5', message: 'hot', securityCategory: 'xss' }],
		regras: new Map([['ts:S1', 'Regra um']]),
	};

	it('o resumo traz o gate, as condições reprovadas e severidades na ordem certa', () => {
		const md = montarResumo(dados);
		assert.match(md, /Quality gate: \*\*ERROR\*\*/);
		assert.match(md, /new_coverage: 10 \(limite LT 80\)/);
		assert.ok(md.indexOf('- BLOCKER: 1') < md.indexOf('- MAJOR: 2'));
	});

	it('o resumo põe as métricas na ordem fixa e mostra rating como letra', () => {
		const md = montarResumo(dados);
		assert.ok(md.indexOf('| Bugs | 0 |') < md.indexOf('| Manutenibilidade | D |'));
	});

	it('a lista agrupa por arquivo (mais issues primeiro) e ordena por linha', () => {
		const md = montarListaDeIssues(dados);
		assert.match(md, /\[`ts:S1`\]\(http:\/\/localhost:9000\/coding_rules\?open=ts%3AS1&rule_key=ts%3AS1\) — Regra um \(2×\)/);
		assert.ok(md.indexOf('### `a.ts` (2)') < md.indexOf('### `b.ts` (1)'));
		assert.ok(md.indexOf('- L2 ') < md.indexOf('- L9 '));
		assert.match(md, /`c.ts`:7 · HIGH · `ts:S5` — hot/);
	});
});
