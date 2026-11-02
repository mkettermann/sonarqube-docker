// Exporta o resultado da última análise de um projeto para arquivos legíveis — por
// gente e por agentes de código — dentro do próprio projeto:
//
//   resumo.md      quality gate, métricas e contagens
//   issues.md      cada issue aberta, agrupada por arquivo e linha, com link da regra
//   issues.json    as issues cruas da API (até 10 mil)
//   hotspots.json  security hotspots a revisar

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
};

/** Ratings vêm como `1.0`…`5.0`; o painel mostra A…E. */
function valorDaMetrica({ metric, value }) {
	return metric.endsWith('_rating') ? ('ABCDE'[Math.round(Number(value)) - 1] ?? value) : value;
}

async function paginar(cliente, caminho, campo, aoLerPagina) {
	const itens = [];
	for (let p = 1; p <= LIMITE_PAGINAS; p++) {
		const { status, json, texto } = await cliente.chamar(`${caminho}&ps=500&p=${p}`);
		if (status >= 300) throw new Error(`Falha em ${caminho} (${status}): ${texto}`);
		aoLerPagina?.(json);
		if (!json?.[campo]?.length) break;
		itens.push(...json[campo]);
		if (itens.length >= (json.paging?.total ?? json.total ?? 0)) break;
	}
	return itens;
}

export async function coletarResultado(cliente, chave) {
	const k = encodeURIComponent(chave);
	const { json: medidas } = await cliente.chamar(`/api/measures/component?component=${k}&metricKeys=${Object.keys(METRICAS).join(',')}`);
	const { json: gate } = await cliente.chamar(`/api/qualitygates/project_status?projectKey=${k}`);
	const regras = new Map();
	const issues = await paginar(cliente, `/api/issues/search?components=${k}&resolved=false&additionalFields=rules`, 'issues', (json) => {
		for (const r of json?.rules ?? []) regras.set(r.key, r.name);
	});
	const hotspots = await paginar(cliente, `/api/hotspots/search?project=${k}&status=TO_REVIEW`, 'hotspots');
	return { medidas: medidas?.component?.measures ?? [], gate: gate?.projectStatus, issues, hotspots, regras };
}

function contar(itens, chave) {
	const mapa = new Map();
	for (const i of itens) {
		const k = chave(i);
		mapa.set(k, (mapa.get(k) ?? 0) + 1);
	}
	return [...mapa.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

const arquivoDe = (chave) => (item) => item.component.replace(`${chave}:`, '');
const posicaoSeveridade = (s) => (ORDEM_SEVERIDADE.includes(s) ? ORDEM_SEVERIDADE.indexOf(s) : ORDEM_SEVERIDADE.length);
const linkRegra = (url, regra) => `${url}/coding_rules?open=${encodeURIComponent(regra)}&rule_key=${encodeURIComponent(regra)}`;

export function montarResumo({ chave, nome, url, medidas, gate, issues, hotspots }) {
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
		...Object.keys(METRICAS)
			.map((metrica) => medidas.find((m) => m.metric === metrica))
			.filter(Boolean)
			.map((m) => `| ${METRICAS[m.metric]} | ${valorDaMetrica(m)} |`),
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

export function montarListaDeIssues({ chave, nome, url, issues, hotspots, regras }) {
	const arquivo = arquivoDe(chave);
	const porArquivo = new Map();
	for (const i of issues) {
		const a = arquivo(i);
		if (!porArquivo.has(a)) porArquivo.set(a, []);
		porArquivo.get(a).push(i);
	}
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

export async function exportarRelatorio(cliente, { chave, nome, dirSaida }) {
	const resultado = await coletarResultado(cliente, chave);
	const dados = { chave, nome, url: cliente.url, ...resultado };
	mkdirSync(dirSaida, { recursive: true });
	writeFileSync(join(dirSaida, 'resumo.md'), montarResumo(dados));
	writeFileSync(join(dirSaida, 'issues.md'), montarListaDeIssues(dados));
	writeFileSync(join(dirSaida, 'issues.json'), JSON.stringify(resultado.issues, null, 2));
	writeFileSync(join(dirSaida, 'hotspots.json'), JSON.stringify(resultado.hotspots, null, 2));
	return dados;
}
