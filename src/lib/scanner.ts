// Roda o `sonarsource/sonar-scanner-cli` num container da rede do SonarQube, com o
// projeto montado em /usr/src. Assim nenhum projeto precisa instalar Java nem scanner.

import { HOST_NA_REDE, REDE, VOLUME_CACHE_SCANNER } from './config.mjs';
import { executar } from './servidor.mjs';

/**
 * Id da tarefa do Compute Engine, lido da PRÓPRIA saída do scanner
 * (`…/api/ce/task?id=<id>`). ⚠️ Não use o `.scannerwork/report-task.txt`: o scanner do
 * container o grava no diretório de trabalho dele e o arquivo pode não aparecer no bind
 * mount — sem o id, o relatório sai antes de o servidor processar a análise, com ZERO
 * issues e sem erro nenhum.
 */
export function idDaTarefa(texto) {
	return /api\/ce\/task\?id=([\w-]+)/.exec(texto)?.[1];
}

export function argumentosDoScanner({ dirProjeto, token, imagem, lcovs = [], extras = [] }) {
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
export async function rodarScanner(opcoes) {
	console.log('[sonar] rodando o scanner (pode levar vários minutos em projetos grandes)…');
	let tarefa;
	await executar('docker', argumentosDoScanner(opcoes), {
		cwd: opcoes.dirProjeto,
		aoLerSaida: (texto) => {
			tarefa = idDaTarefa(texto) ?? tarefa;
		},
	});
	return tarefa;
}
