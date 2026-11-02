#!/usr/bin/env node
// sonar-local — analisa qualquer projeto desta máquina contra o SonarQube local
// compartilhado (docker-compose.yml deste repositório). Zero dependências em runtime.
//
// Instalação (uma vez por máquina, na pasta deste repositório): `npm install` e `npm link`
// (o `prepare` compila src/ para dist/, para onde o comando global aponta).
// Uso: veja `sonar-local help` ou docs/novo-projeto.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { prepararCoberturas } from '../lib/cobertura.ts';
import {
	ADMIN_LOGIN,
	RAIZ_SERVIDOR,
	type ChaveValor,
	type Opcoes,
	carregarAmbiente,
	lerArgumentos,
	lerPropriedadesDoProjeto,
	relativoAoProjeto,
} from '../lib/config.ts';
import { exportarRelatorio } from '../lib/relatorio.ts';
import { rodarScanner } from '../lib/scanner.ts';
import {
	type Cliente,
	aguardarProcessamento,
	compose,
	criarCliente,
	emitirTokenDeAnalise,
	emitirTokenDeUsuario,
	garantirProjeto,
	garantirSenhaAdmin,
	garantirServidor,
	statusDoServidor,
} from '../lib/servidor.ts';

const AJUDA = `sonar-local — SonarQube local compartilhado (${RAIZ_SERVIDOR})

Uso: sonar-local <comando> [opções] [-- argumentos extras do scanner]

Comandos (rodados na raiz do projeto a analisar, ou com --dir):
  init      cria um sonar-project.properties inicial no projeto
  scan      analisa o projeto e exporta o relatório (sobe o servidor se preciso)
  report    só reexporta o relatório da última análise
  token     emite um token de usuário (ex.: SonarQube for IDE em modo conectado)

Comandos do servidor:
  setup     sobe (se preciso) e define a senha do admin pelo .env — rode após instalar
  up        sobe o SonarQube (docker compose up -d)
  down      derruba o SonarQube (os dados ficam nos volumes)
  status    mostra se o servidor está no ar

Opções:
  --dir <pasta>     projeto a analisar (padrão: pasta atual)
  --saida <pasta>   onde gravar o relatório, dentro do projeto (padrão: .sonar-local)
  --sem-cobertura   não procura/envia lcov.info
  -- <args>         repassados ao scanner, ex.: -- -Dsonar.verbose=true

Relatório: <saida>/resumo.md, issues.md, issues.json, hotspots.json.`;

interface Projeto {
	props: ChaveValor;
	chave: string;
	nome: string;
}

function exigirProjeto(dir: string): Projeto {
	const props = lerPropriedadesDoProjeto(dir);
	if (!props) {
		throw new Error(`Não há sonar-project.properties em ${dir}. Rode \`sonar-local init\` (ver docs/novo-projeto.md).`);
	}
	const chave = props['sonar.projectKey'];
	if (!chave) throw new Error(`sonar.projectKey não definido em ${join(dir, 'sonar-project.properties')}.`);
	return { props, chave, nome: props['sonar.projectName'] || chave };
}

async function clientePronto() {
	const ambiente = carregarAmbiente();
	if (!ambiente.temEnv) throw new Error(`Falta o .env em ${RAIZ_SERVIDOR}: copie .env.example para .env e defina SONAR_ADMIN_PASSWORD.`);
	const cliente = criarCliente(ambiente.url, ambiente.senhaAdmin);
	await garantirServidor(cliente);
	await garantirSenhaAdmin(cliente);
	return { cliente, ambiente };
}

async function scan(opcoes: Opcoes): Promise<void> {
	const { props, chave, nome } = exigirProjeto(opcoes.dir);
	if (!relativoAoProjeto(opcoes.dir, opcoes.saida)) throw new Error('--saida precisa ficar dentro do projeto (o scanner só enxerga a pasta do projeto).');
	const { cliente, ambiente } = await clientePronto();
	await garantirProjeto(cliente, chave, nome);
	const token = await emitirTokenDeAnalise(cliente, chave);
	const lcovs = opcoes.semCobertura ? [] : prepararCoberturas(opcoes.dir, opcoes.saida, props);
	const tarefa = await rodarScanner({ dirProjeto: opcoes.dir, token, imagem: ambiente.imagemScanner, lcovs, extras: opcoes.extras, dirSaida: opcoes.saida });
	await aguardarProcessamento(cliente, tarefa);
	await report(opcoes, { cliente, chave, nome });
}

async function report(opcoes: Opcoes, contexto?: { cliente: Cliente; chave: string; nome: string }): Promise<void> {
	const { chave, nome } = contexto ?? exigirProjeto(opcoes.dir);
	const cliente = contexto?.cliente ?? (await clientePronto()).cliente;
	const { gate, issues, hotspots } = await exportarRelatorio(cliente, { chave, nome, dirSaida: opcoes.saida });
	const saida = relativoAoProjeto(opcoes.dir, opcoes.saida) ?? opcoes.saida;
	console.log('');
	console.log(`[sonar] quality gate: ${gate?.status ?? '?'} — ${issues.length} issues abertas, ${hotspots.length} hotspots a revisar`);
	console.log(`[sonar] relatório: ${saida}/resumo.md e ${saida}/issues.md`);
	console.log(`[sonar] painel: ${cliente.url}/dashboard?id=${encodeURIComponent(chave)} (login ${ADMIN_LOGIN}, senha SONAR_ADMIN_PASSWORD do .env)`);
}

function init(opcoes: Opcoes): void {
	const destino = join(opcoes.dir, 'sonar-project.properties');
	if (existsSync(destino)) {
		console.log(`[sonar] ${destino} já existe — nada a fazer.`);
		return;
	}
	const nome = basename(opcoes.dir);
	const chave = opcoes.posicionais[0] ?? nome.toLowerCase().replaceAll(/[^a-z0-9_.:-]+/g, '-');
	const modelo = readFileSync(resolve(RAIZ_SERVIDOR, 'templates', 'sonar-project.properties'), 'utf8');
	writeFileSync(destino, modelo.replaceAll('{{CHAVE}}', chave).replaceAll('{{NOME}}', nome));
	console.log(`[sonar] criado ${destino} (projectKey=${chave}). Ajuste sonar.sources/exclusions e rode \`sonar-local scan\`.`);
	console.log('[sonar] adicione ao .gitignore do projeto: .scannerwork/ e .sonar-local/');
}

async function token(opcoes: Opcoes): Promise<void> {
	const { cliente } = await clientePronto();
	const nome = opcoes.posicionais[0] ?? `sonar-local-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
	console.log(`[sonar] token "${nome}" (guarde: ele não é exibido de novo):`);
	console.log(await emitirTokenDeUsuario(cliente, nome));
}

async function setup(): Promise<void> {
	const { cliente } = await clientePronto();
	console.log(`[sonar] pronto: ${cliente.url} — login ${ADMIN_LOGIN}, senha SONAR_ADMIN_PASSWORD do .env.`);
}

async function status(): Promise<void> {
	const { url } = carregarAmbiente();
	const s = await statusDoServidor(criarCliente(url, ''));
	console.log(s ? `[sonar] ${url} — ${s}` : `[sonar] ${url} não responde (rode \`sonar-local up\`).`);
	if (s !== 'UP') process.exitCode = 1;
}

const COMANDOS: Record<string, (opcoes: Opcoes) => void | Promise<void>> = {
	scan,
	report: (o) => report(o),
	init,
	token,
	setup,
	up: () => compose(['up', '-d']),
	down: () => compose(['down']),
	status,
	help: () => console.log(AJUDA),
};

try {
	const opcoes = lerArgumentos(process.argv.slice(2));
	// `Object.hasOwn`: `sonar-local toString` não pode cair no protótipo do objeto.
	const comando = Object.hasOwn(COMANDOS, opcoes.comando) ? COMANDOS[opcoes.comando] : undefined;
	if (!comando) throw new Error(`Comando desconhecido: ${opcoes.comando} (veja \`sonar-local help\`).`);
	await comando(opcoes);
} catch (e) {
	console.error(`[sonar] ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}
