// Roda o `sonarsource/sonar-scanner-cli` num container da rede do SonarQube, com o
// projeto montado em /usr/src. Assim nenhum projeto precisa instalar Java nem scanner.

import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { HOST_NA_REDE, REDE, VOLUME_CACHE_SCANNER } from './config.ts';
import { executar } from './servidor.ts';

export interface OpcoesDoScanner {
	dirProjeto: string;
	token: string;
	imagem: string;
	/** Caminhos dos lcov, relativos à raiz do projeto. */
	lcovs?: string[];
	/** Argumentos repassados intactos ao scanner (o que vem depois de `--`). */
	extras?: string[];
	/** Pasta do relatório: para onde vão os logs de crash da JVM, se houver. */
	dirSaida?: string;
}

/** Logs que a JVM grava no diretório de trabalho quando cai com crash nativo. */
const LOG_DE_CRASH = /^(hs_err|replay)_pid\d+\.log$/;

export function logsDeCrash(dir: string): string[] {
	return readdirSync(dir).filter((nome) => LOG_DE_CRASH.test(nome));
}

/**
 * Move para `dirSaida` os logs de crash que apareceram na raiz do projeto durante a
 * análise (o diretório de trabalho do scanner é o bind mount, então eles iriam parar
 * ali). Os que já existiam antes ficam onde estão. Devolve os nomes movidos.
 */
export function recolherLogsDeCrash(dirProjeto: string, dirSaida: string, existentes: ReadonlySet<string>): string[] {
	const novos = logsDeCrash(dirProjeto).filter((nome) => !existentes.has(nome));
	if (novos.length) mkdirSync(dirSaida, { recursive: true });
	for (const nome of novos) renameSync(join(dirProjeto, nome), join(dirSaida, nome));
	return novos;
}

/**
 * Id da tarefa do Compute Engine, lido da PRÓPRIA saída do scanner
 * (`…/api/ce/task?id=<id>`). ⚠️ Não use o `.scannerwork/report-task.txt`: o scanner do
 * container o grava no diretório de trabalho dele e o arquivo pode não aparecer no bind
 * mount — sem o id, o relatório sai antes de o servidor processar a análise, com ZERO
 * issues e sem erro nenhum.
 */
export function idDaTarefa(texto: string): string | undefined {
	return /api\/ce\/task\?id=([\w-]+)/.exec(texto)?.[1];
}

export function argumentosDoScanner({ dirProjeto, token, imagem, lcovs = [], extras = [] }: OpcoesDoScanner): string[] {
	const args = [
		'run', '--rm',
		'--network', REDE,
		'-v', `${dirProjeto}:/usr/src`,
		'-v', `${VOLUME_CACHE_SCANNER}:/opt/sonar-scanner/.sonar/cache`,
		'-e', `SONAR_HOST_URL=${HOST_NA_REDE}`,
		'-e', `SONAR_TOKEN=${token}`,
		imagem,
	];
	if (lcovs.length) args.push(`-Dsonar.javascript.lcov.reportPaths=${lcovs.join(',')}`);
	args.push(...extras);
	return args;
}

/** Roda o scanner e devolve o id da tarefa que o servidor vai processar. */
export async function rodarScanner(opcoes: OpcoesDoScanner): Promise<string | undefined> {
	console.log('[sonar] rodando o scanner (pode levar vários minutos em projetos grandes)…');
	const existentes = new Set(logsDeCrash(opcoes.dirProjeto));
	let tarefa: string | undefined;
	try {
		await executar('docker', argumentosDoScanner(opcoes), {
			cwd: opcoes.dirProjeto,
			aoLerSaida: (texto) => {
				tarefa = idDaTarefa(texto) ?? tarefa;
			},
		});
	} catch (e) {
		// Crashes nativos do scanner (bridge do Node, SIGSEGV da JVM) são intermitentes em
		// projetos grandes: a mesma análise costuma passar numa tentativa seguinte.
		const motivo = e instanceof Error ? e.message : String(e);
		throw new Error(`${motivo} Se foi crash nativo do scanner, rode de novo antes de mexer na configuração (ver docs/operacao.md).`);
	} finally {
		if (opcoes.dirSaida) {
			const movidos = recolherLogsDeCrash(opcoes.dirProjeto, opcoes.dirSaida, existentes);
			if (movidos.length) console.log(`[sonar] logs de crash da JVM movidos para ${opcoes.dirSaida}: ${movidos.join(', ')}`);
		}
	}
	return tarefa;
}
