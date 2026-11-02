import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';

import {
	aguardarProcessamento,
	criarCliente,
	emitirTokenDeAnalise,
	emitirTokenDeUsuario,
	executar,
	garantirProjeto,
	garantirSenhaAdmin,
	garantirServidor,
	statusDoServidor,
} from '../src/lib/servidor.ts';
import { type Rotas, type SonarFalso, basic, sonarFalso } from './apoio.ts';

const SENHA = 'Senha.Do.Env.123';

let sonar: SonarFalso | undefined;
async function subir(rotas: Rotas) {
	sonar = await sonarFalso(rotas);
	return { sonar, cliente: criarCliente(sonar.url, SENHA) };
}

beforeEach(() => {
	mock.method(console, 'log', () => {});
	mock.method(console, 'warn', () => {});
});
after(async () => {
	await sonar?.fechar();
});

describe('criarCliente', () => {
	it('autentica como admin, envia form urlencoded e interpreta o JSON', async () => {
		const { sonar, cliente } = await subir({ 'POST /api/x': (c) => ({ status: 201, json: { recebido: c.form } }) });
		const r = await cliente.chamar<{ recebido: Record<string, string> }>('/api/x', { metodo: 'POST', form: { a: '1', b: 'dois e três' } });
		assert.equal(r.status, 201);
		assert.deepEqual(r.json?.recebido, { a: '1', b: 'dois e três' });
		assert.equal(sonar.chamadas[0]?.auth, basic('admin', SENHA));
		await sonar.fechar();
	});

	it('devolve json null para corpo vazio ou que não é JSON, e chama sem auth com auth: null', async () => {
		const { sonar, cliente } = await subir({
			'GET /vazio': () => ({ status: 204 }),
			'GET /html': () => ({ status: 500, texto: '<html>erro</html>' }),
		});
		assert.deepEqual(await cliente.chamar('/vazio', { auth: null }), { status: 204, json: null, texto: '' });
		assert.deepEqual(await cliente.chamar('/html'), { status: 500, json: null, texto: '<html>erro</html>' });
		assert.equal(sonar.chamadas[0]?.auth, undefined);
		await sonar.fechar();
	});
});

describe('statusDoServidor', () => {
	it('lê o status sem autenticação, e devolve null se o servidor não responde', async () => {
		const { sonar, cliente } = await subir({ 'GET /api/system/status': () => ({ json: { status: 'UP' } }) });
		assert.equal(await statusDoServidor(cliente), 'UP');
		assert.equal(sonar.chamadas[0]?.auth, undefined);
		await sonar.fechar();
		assert.equal(await statusDoServidor(criarCliente('http://endereço inválido', '')), null);
	});
});

describe('garantirServidor', () => {
	const comStatus = (...status: string[]): Rotas => ({ 'GET /api/system/status': () => ({ json: { status: status.shift() ?? 'UP' } }) });

	it('retorna logo se já está UP', async () => {
		const { sonar, cliente } = await subir(comStatus('UP'));
		await garantirServidor(cliente);
		assert.equal(sonar.chamadas.length, 1);
		await sonar.fechar();
	});

	it('pede para abrir o /setup quando o banco precisa migrar', async () => {
		const { sonar, cliente } = await subir(comStatus('STARTING', 'DB_MIGRATION_NEEDED'));
		await assert.rejects(garantirServidor(cliente), /precisa migrar o banco/);
		await sonar.fechar();
	});

	it('desiste depois do timeout', async () => {
		const { sonar, cliente } = await subir(comStatus('STARTING'));
		await assert.rejects(garantirServidor(cliente, { timeoutMs: 0 }), /não ficou UP em 0s/);
		await sonar.fechar();
	});
});

describe('garantirSenhaAdmin', () => {
	const validas = (...senhas: string[]): Rotas => ({
		'GET /api/authentication/validate': (c) => ({ json: { valid: senhas.some((s) => c.auth === basic('admin', s)) } }),
		'POST /api/users/change_password': () => ({ status: 204 }),
	});

	it('exige a senha no .env', async () => {
		await assert.rejects(garantirSenhaAdmin(criarCliente('http://localhost:1', '')), /SONAR_ADMIN_PASSWORD vazio/);
	});

	it('não faz nada se a senha do .env já vale', async () => {
		const { sonar, cliente } = await subir(validas(SENHA));
		await garantirSenhaAdmin(cliente);
		assert.equal(sonar.chamadas.length, 1);
		await sonar.fechar();
	});

	it('troca admin/admin pela senha do .env no primeiro uso', async () => {
		const { sonar, cliente } = await subir(validas('admin'));
		await garantirSenhaAdmin(cliente);
		const troca = sonar.chamadas.find((c) => c.caminho === '/api/users/change_password');
		assert.deepEqual(troca?.form, { login: 'admin', previousPassword: 'admin', password: SENHA });
		assert.equal(troca?.auth, basic('admin', 'admin'));
		await sonar.fechar();
	});

	it('falha se nem a senha do .env nem a padrão valem, ou se a troca falha', async () => {
		const nenhuma = await subir(validas());
		await assert.rejects(garantirSenhaAdmin(nenhuma.cliente), /não confere com a do servidor/);
		await nenhuma.sonar.fechar();

		const trocaFalha = await subir({ ...validas('admin'), 'POST /api/users/change_password': () => ({ status: 400, texto: 'fraca' }) });
		await assert.rejects(garantirSenhaAdmin(trocaFalha.cliente), /Falha ao trocar a senha do admin \(400\): fraca/);
		await trocaFalha.sonar.fechar();
	});
});

describe('garantirProjeto', () => {
	it('não recria projeto existente', async () => {
		const { sonar, cliente } = await subir({ 'GET /api/projects/search': () => ({ json: { components: [{ key: 'p' }] } }) });
		await garantirProjeto(cliente, 'p', 'P');
		assert.equal(sonar.chamadas.length, 1);
		assert.equal(sonar.chamadas[0]?.query.get('projects'), 'p');
		await sonar.fechar();
	});

	it('cria o projeto que falta, e propaga a falha da criação', async () => {
		let status = 200;
		const { sonar, cliente } = await subir({
			'GET /api/projects/search': () => ({ json: { components: [] } }),
			'POST /api/projects/create': () => ({ status, texto: 'resposta' }),
		});
		await garantirProjeto(cliente, 'p', 'Projeto P');
		assert.deepEqual(sonar.chamadas.at(-1)?.form, { project: 'p', name: 'Projeto P' });
		status = 400;
		await assert.rejects(garantirProjeto(cliente, 'p', 'Projeto P'), /Falha ao criar o projeto p \(400\)/);
		await sonar.fechar();
	});
});

describe('tokens', () => {
	it('o token de análise revoga o anterior e é restrito ao projeto', async () => {
		const { sonar, cliente } = await subir({
			'POST /api/user_tokens/revoke': () => ({ status: 204 }),
			'POST /api/user_tokens/generate': (c) => ({ json: { token: `tk-${c.form.type}` } }),
		});
		assert.equal(await emitirTokenDeAnalise(cliente, 'p'), 'tk-PROJECT_ANALYSIS_TOKEN');
		assert.deepEqual(
			sonar.chamadas.map((c) => [c.caminho, c.form]),
			[
				['/api/user_tokens/revoke', { name: 'sonar-local-scan-p' }],
				['/api/user_tokens/generate', { name: 'sonar-local-scan-p', type: 'PROJECT_ANALYSIS_TOKEN', projectKey: 'p' }],
			],
		);
		assert.equal(await emitirTokenDeUsuario(cliente, 'ide'), 'tk-USER_TOKEN');
		await sonar.fechar();
	});

	it('falha quando o servidor não devolve token', async () => {
		const { sonar, cliente } = await subir({ 'POST /api/user_tokens/generate': () => ({ status: 400, texto: 'já existe' }) });
		await assert.rejects(emitirTokenDeAnalise(cliente, 'p'), /token de análise \(400\): já existe/);
		await assert.rejects(emitirTokenDeUsuario(cliente, 'ide'), /gerar o token \(400\): já existe/);
		await sonar.fechar();
	});
});

describe('aguardarProcessamento', () => {
	const tarefa = (status: number, json: unknown): Rotas => ({ 'GET /api/ce/task': () => ({ status, json }) });

	it('só avisa quando não há id da tarefa', async (t) => {
		const avisos = t.mock.method(console, 'warn', () => {});
		await aguardarProcessamento(criarCliente('http://localhost:1', SENHA), undefined);
		assert.equal(avisos.mock.callCount(), 1);
		assert.match(String(avisos.mock.calls[0]?.arguments[0]), /id da tarefa não encontrado/);
	});

	it('termina quando a tarefa dá SUCCESS', async () => {
		const { sonar, cliente } = await subir(tarefa(200, { task: { status: 'SUCCESS' } }));
		await aguardarProcessamento(cliente, 'AZ-1');
		assert.equal(sonar.chamadas[0]?.query.get('id'), 'AZ-1');
		await sonar.fechar();
	});

	it('falha quando a tarefa falha, a consulta dá erro ou o tempo acaba', async () => {
		const falhou = await subir(tarefa(200, { task: { status: 'FAILED', errorMessage: 'sem memória' } }));
		await assert.rejects(aguardarProcessamento(falhou.cliente, 'AZ-1'), /FAILED — sem memória/);
		await falhou.sonar.fechar();

		const erroHttp = await subir(tarefa(404, { errors: [] }));
		await assert.rejects(aguardarProcessamento(erroHttp.cliente, 'AZ-1'), /consultar a tarefa AZ-1 \(404\)/);
		await erroHttp.sonar.fechar();

		await assert.rejects(aguardarProcessamento(criarCliente('http://localhost:1', SENHA), 'AZ-1', { timeoutMs: 0 }), /não terminou em 0 min/);
	});
});

describe('executar', () => {
	it('repassa o stdout ao terminal e a quem pediu', async (t) => {
		const escrito: string[] = [];
		t.mock.method(process.stdout, 'write', (texto: string) => escrito.push(texto));
		const lido: string[] = [];
		await executar(process.execPath, ['-e', 'process.stdout.write("api/ce/task?id=X")'], { aoLerSaida: (texto) => lido.push(texto) });
		assert.equal(lido.join(''), 'api/ce/task?id=X');
		// O test runner também escreve no stdout (protocolo com o processo pai): só confere o pedaço.
		assert.ok(escrito.includes('api/ce/task?id=X'));
	});

	it('falha com o código de saída, ou com mensagem clara se o comando não existe', async () => {
		await assert.rejects(executar(process.execPath, ['-e', 'process.exit(3)']), /terminou com código 3/);
		await assert.rejects(executar('comando-que-nao-existe-sonar-local', []), /`comando-que-nao-existe-sonar-local` não encontrado no PATH/);
	});
});
