// Roda o CLI de verdade (src/bin/sonar-local.ts, num processo filho) nos comandos que
// não dependem do .env deste repositório nem do Docker.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { apagarTemporarios, pastaTemporaria, sonarFalso } from './apoio.ts';

const CLI = resolve(import.meta.dirname, '..', 'src', 'bin', 'sonar-local.ts');

interface Saida {
	codigo: number;
	stdout: string;
	stderr: string;
}

async function sonarLocal(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Saida> {
	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
		return { codigo: 0, stdout, stderr };
	} catch (e) {
		const { code, stdout, stderr } = e as { code: number; stdout: string; stderr: string };
		return { codigo: code, stdout, stderr };
	}
}

after(apagarTemporarios);

describe('sonar-local (CLI)', () => {
	it('mostra a ajuda sem argumentos e com help', async () => {
		for (const args of [[], ['help'], ['--help']]) {
			const r = await sonarLocal(args);
			assert.equal(r.codigo, 0);
			assert.match(r.stdout, /Uso: sonar-local <comando>/);
		}
	});

	it('recusa comando e opção desconhecidos com código 1', async () => {
		const comando = await sonarLocal(['toString']);
		assert.equal(comando.codigo, 1);
		assert.match(comando.stderr, /Comando desconhecido: toString/);

		const opcao = await sonarLocal(['scan', '--xyz']);
		assert.equal(opcao.codigo, 1);
		assert.match(opcao.stderr, /Opção desconhecida: --xyz/);
	});

	it('scan e report exigem o sonar-project.properties no projeto', async () => {
		for (const comando of ['scan', 'report']) {
			const r = await sonarLocal([comando, '--dir', pastaTemporaria()]);
			assert.equal(r.codigo, 1);
			assert.match(r.stderr, /Não há sonar-project.properties/);
		}
	});

	it('init cria o properties a partir do modelo, uma vez só', async () => {
		const dir = join(pastaTemporaria(), 'Meu Projeto');
		mkdirSync(dir);
		const r = await sonarLocal(['init', '--dir', dir]);
		assert.equal(r.codigo, 0);
		const props = readFileSync(join(dir, 'sonar-project.properties'), 'utf8');
		assert.match(props, /^sonar\.projectKey=meu-projeto$/m);
		assert.match(props, /^sonar\.projectName=Meu Projeto$/m);

		const deNovo = await sonarLocal(['init', '--dir', dir, 'outra-chave']);
		assert.match(deNovo.stdout, /já existe/);
		assert.equal(readFileSync(join(dir, 'sonar-project.properties'), 'utf8'), props);
	});

	it('init aceita a chave como argumento', async () => {
		const dir = pastaTemporaria();
		await sonarLocal(['init', '--dir', dir, 'chave-escolhida']);
		assert.ok(existsSync(join(dir, 'sonar-project.properties')));
		assert.match(readFileSync(join(dir, 'sonar-project.properties'), 'utf8'), /^sonar\.projectKey=chave-escolhida$/m);
	});

	it('status sai com 0 se o servidor está UP e com 1 se não', async () => {
		let status = 'UP';
		const sonar = await sonarFalso({ 'GET /api/system/status': () => ({ json: { status } }) });
		const up = await sonarLocal(['status'], { SONAR_URL: sonar.url });
		assert.equal(up.codigo, 0);
		assert.match(up.stdout, /— UP/);

		status = 'STARTING';
		assert.equal((await sonarLocal(['status'], { SONAR_URL: sonar.url })).codigo, 1);
		await sonar.fechar();

		const fora = await sonarLocal(['status'], { SONAR_URL: sonar.url });
		assert.equal(fora.codigo, 1);
		assert.match(fora.stdout, /não responde/);
	});
});
