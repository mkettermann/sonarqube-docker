// Exporta o resultado da última análise de um projeto para arquivos legíveis — por
// gente e por agentes de código — dentro do próprio projeto:
//
//   resumo.md      quality gate, métricas e contagens
//   issues.md      cada issue aberta, agrupada por arquivo e linha, com link da regra
//   issues.json    as issues cruas da API (até 10 mil)
//   hotspots.json  security hotspots a revisar

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Cliente } from './servidor.ts';

const LIMITE_PAGINAS = 20; // 20 × 500 = 10 mil: o teto da paginação da API de issues
const ORDEM_SEVERIDADE = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];

const METRICAS = {
	ncloc: 'Linhas de código',
	bugs: 'Bugs',
	vulnerabilities: 'Vulnerabilidades',
	code_smells: 'Code smells',
	security_hotspots: 'Security hotspots',
	coverage: 'Cobertura (%)',
	duplicated_lines_density: 'Duplicação (%)',
	reliability_rating: 'Confiabilidade',
	security_rating: 'Segurança',
	sqale_rating: 'Manutenibilidade',
} as const satisfies Record<string, string>;

type Metrica = keyof typeof METRICAS;
const CHAVES_METRICAS = Object.keys(METRICAS) as Metrica[];

// Só os campos usados aqui; os JSON exportados levam o objeto completo da API.
export interface Medida {
	metric: string;
	value: string;
}

export interface CondicaoDoGate {
	status: string;
	metricKey: string;
	actualValue?: string;
	comparator?: string;
	errorThreshold?: string;
}

export interface Gate {
	status?: string;
	conditions?: CondicaoDoGate[];
}

export interface Issue {
	component: string;
	rule: string;
	message: string;
	line?: number;
	severity?: string;
	type?: string;
}

export interface Hotspot {
	component: string;
	ruleKey: string;
	message: string;
	line?: number;
	securityCategory?: string;
	vulnerabilityProbability?: string;
}

export interface Resultado {
	medidas: Medida[];
	gate: Gate | undefined;
	issues: Issue[];
	hotspots: Hotspot[];
	/** Chave da regra → nome. */
	regras: Map<string, string>;
}

export interface DadosDoRelatorio extends Resultado {
	chave: string;
	nome: string;
	url: string;
}

interface Pagina {
	paging?: { total?: number };
	total?: number;
	[campo: string]: unknown;
}

/** Ratings vêm como `1.0`…`5.0`; o painel mostra A…E. */
function valorDaMetrica({ metric, value }: Medida): string {
	return metric.endsWith('_rating') ? ('ABCDE'[Math.round(Number(value)) - 1] ?? value) : value;
}

async function paginar<T, P extends Pagina = Pagina>(cliente: Cliente, caminho: string, campo: string, aoLerPagina?: (json: P | null) => void): Promise<T[]> {
	const itens: T[] = [];
	for (let p = 1; p <= LIMITE_PAGINAS; p++) {
		const { status, json, texto } = await cliente.chamar<P>(`${caminho}&ps=500&p=${p}`);
		if (status >= 300) throw new Error(`Falha em ${caminho} (${status}): ${texto}`);
		aoLerPagina?.(json);
		const pagina = json?.[campo] as T[] | undefined;
		if (!pagina?.length) break;
		itens.push(...pagina);
		if (itens.length >= (json?.paging?.total ?? json?.total ?? 0)) break;
	}
	return itens;
}

export async function coletarResultado(cliente: Cliente, chave: string): Promise<Resultado> {
	const k = encodeURIComponent(chave);
	const { json: medidas } = await cliente.chamar<{ component?: { measures?: Medida[] } }>(
		`/api/measures/component?component=${k}&metricKeys=${CHAVES_METRICAS.join(',')}`,
	);
	const { json: gate } = await cliente.chamar<{ projectStatus?: Gate }>(`/api/qualitygates/project_status?projectKey=${k}`);
	const regras = new Map<string, string>();
	const issues = await paginar<Issue, Pagina & { rules?: { key: string; name: string }[] }>(
		cliente,
		`/api/issues/search?components=${k}&resolved=false&additionalFields=rules`,
		'issues',
		(json) => {
			for (const r of json?.rules ?? []) regras.set(r.key, r.name);
		},
	);
	const hotspots = await paginar<Hotspot>(cliente, `/api/hotspots/search?project=${k}&status=TO_REVIEW`, 'hotspots');
	return { medidas: medidas?.component?.measures ?? [], gate: gate?.projectStatus, issues, hotspots, regras };
}

function contar<T>(itens: readonly T[], chave: (item: T) => string): [string, number][] {
	const mapa = new Map<string, number>();
	for (const i of itens) {
		const k = chave(i);
		mapa.set(k, (mapa.get(k) ?? 0) + 1);
	}
	return [...mapa.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const arquivoDe =
	(chave: string) =>
	(item: { component: string }): string =>
		item.component.replace(`${chave}:`, '');
const posicaoSeveridade = (s: string): number => (ORDEM_SEVERIDADE.includes(s) ? ORDEM_SEVERIDADE.indexOf(s) : ORDEM_SEVERIDADE.length);
const linkRegra = (url: string, regra: string): string => `${url}/coding_rules?open=${encodeURIComponent(regra)}&rule_key=${encodeURIComponent(regra)}`;

export function montarResumo({ chave, nome, url, medidas, gate, issues, hotspots }: DadosDoRelatorio): string {
	const condicoesReprovadas = (gate?.conditions ?? []).filter((c) => c.status === 'ERROR');
	return [
		`# Relatório SonarQube — ${nome}`,
		'',
		`Painel: ${url}/dashboard?id=${encodeURIComponent(chave)}`,
		'',
		`Quality gate: **${gate?.status ?? '?'}**`,
		...condicoesReprovadas.map((c) => `- ❌ ${c.metricKey}: ${c.actualValue} (limite ${c.comparator} ${c.errorThreshold})`),
		'',
		'| Métrica | Valor |',
		'|---|---|',
		...CHAVES_METRICAS.flatMap((metrica) => {
			const m = medidas.find((x) => x.metric === metrica);
			return m ? [`| ${METRICAS[metrica]} | ${valorDaMetrica(m)} |`] : [];
		}),
		'',
		`## Issues abertas: ${issues.length}`,
		'',
		'Lista completa, por arquivo e linha: `issues.md`.',
		'',
		'### Por severidade',
		...contar(issues, (i) => i.severity ?? '?')
			.sort((a, b) => posicaoSeveridade(a[0]) - posicaoSeveridade(b[0]))
			.map(([k, n]) => `- ${k}: ${n}`),
		'',
		'### Por tipo',
		...contar(issues, (i) => i.type ?? '?').map(([k, n]) => `- ${k}: ${n}`),
		'',
		'### Regras mais violadas',
		...contar(issues, (i) => i.rule)
			.slice(0, 40)
			.map(([k, n]) => `- ${n}× \`${k}\``),
		'',
		'### Arquivos com mais issues',
		...contar(issues, arquivoDe(chave))
			.slice(0, 40)
			.map(([k, n]) => `- ${n} — \`${k}\``),
		'',
		`## Security hotspots a revisar: ${hotspots.length}`,
		...contar(hotspots, (h) => `${h.securityCategory} (${h.vulnerabilityProbability})`).map(([k, n]) => `- ${n}× ${k}`),
		'',
	].join('\n');
}

export function montarListaDeIssues({ chave, nome, url, issues, hotspots, regras }: DadosDoRelatorio): string {
	const arquivo = arquivoDe(chave);
	const porArquivo = Map.groupBy(issues, arquivo);
	const arquivos = [...porArquivo.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

	const linhas = [
		`# Issues SonarQube — ${nome}`,
		'',
		`${issues.length} issues abertas em ${porArquivo.size} arquivos, ${hotspots.length} security hotspots a revisar.`,
		'Arquivos com mais issues primeiro; dentro de cada arquivo, por linha. O link de cada regra explica',
		'por que ela existe e mostra o exemplo de código não conforme e o corrigido.',
		'',
		'## Regras',
		'',
		...contar(issues, (i) => i.rule).map(([r, n]) => `- [\`${r}\`](${linkRegra(url, r)}) — ${regras.get(r) ?? ''} (${n}×)`),
		'',
		'## Issues por arquivo',
	];
	for (const [a, lista] of arquivos) {
		linhas.push('', `### \`${a}\` (${lista.length})`, '');
		lista.sort((x, y) => (x.line ?? 0) - (y.line ?? 0));
		for (const i of lista) {
			const onde = i.line ? `L${i.line}` : 'arquivo';
			linhas.push(`- ${onde} · ${i.severity ?? '?'} · ${i.type ?? '?'} · \`${i.rule}\` — ${i.message}`);
		}
	}
	if (hotspots.length) {
		linhas.push('', '## Security hotspots a revisar', '', 'Não são defeitos confirmados: código sensível que precisa de revisão humana.', '');
		const ordenados = [...hotspots].sort((x, y) => arquivo(x).localeCompare(arquivo(y)) || (x.line ?? 0) - (y.line ?? 0));
		for (const h of ordenados) {
			const linha = h.line ? ':' + h.line : '';
			linhas.push(`- \`${arquivo(h)}\`${linha} · ${h.vulnerabilityProbability} · \`${h.ruleKey}\` — ${h.message}`);
		}
	}
	linhas.push('');
	return linhas.join('\n');
}

export async function exportarRelatorio(cliente: Cliente, { chave, nome, dirSaida }: { chave: string; nome: string; dirSaida: string }): Promise<DadosDoRelatorio> {
	const resultado = await coletarResultado(cliente, chave);
	const dados: DadosDoRelatorio = { chave, nome, url: cliente.url, ...resultado };
	mkdirSync(dirSaida, { recursive: true });
	writeFileSync(join(dirSaida, 'resumo.md'), montarResumo(dados));
	writeFileSync(join(dirSaida, 'issues.md'), montarListaDeIssues(dados));
	writeFileSync(join(dirSaida, 'issues.json'), JSON.stringify(resultado.issues, null, 2));
	writeFileSync(join(dirSaida, 'hotspots.json'), JSON.stringify(resultado.hotspots, null, 2));
	return dados;
}
