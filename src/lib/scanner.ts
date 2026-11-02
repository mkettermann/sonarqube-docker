// Roda o `sonarsource/sonar-scanner-cli` num container da rede do SonarQube, com o
// projeto montado em /usr/src. Assim nenhum projeto precisa instalar Java nem scanner.

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
	let tarefa: string | undefined;
	await executar('docker', argumentosDoScanner(opcoes), {
		cwd: opcoes.dirProjeto,
		aoLerSaida: (texto) => {
			tarefa = idDaTarefa(texto) ?? tarefa;
		},
	});
	return tarefa;
}
