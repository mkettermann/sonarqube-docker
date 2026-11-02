# Analisar um projeto novo

Como colocar qualquer projeto da máquina para ser analisado pelo SonarQube compartilhado e
usar o resultado para melhorar o código. Pré-requisito: a máquina instalada conforme
[instalacao.md](instalacao.md) (`sonar-local help` responde).

## 1. Criar o `sonar-project.properties`

Na raiz do projeto:

```text
sonar-local init                # projectKey = nome da pasta, em minúsculas
sonar-local init minha-chave    # ou escolha a chave
```

O arquivo nasce do [modelo](../templates/sonar-project.properties). Ajuste:

- **`sonar.projectKey`**: identifica o projeto no servidor e precisa ser **única na máquina**.
  Analisar com a chave de outro projeto sobrescreve o histórico dele.
- **`sonar.sources`**: as pastas de código, separadas por vírgula. Liste as pastas em vez de
  `.`; assim o scanner nem entra em `node_modules`, `venv` e pastas de build.
- **`sonar.tests`**, **`sonar.exclusions`** e **`sonar.test.inclusions`**: quando os testes
  ficam ao lado do código (`x.ts` + `x.test.ts`), aponte `sonar.tests` para a mesma pasta e
  separe-os por padrão de nome.
- **`sonar.typescript.tsconfigPaths`**: em monorepos TypeScript, liste os `tsconfig` de cada
  pacote.

Versione o arquivo: ele faz parte do projeto.

## 2. Ignorar o que a análise gera

No `.gitignore` do projeto:

```gitignore
# SonarQube local (sonar-local)
.scannerwork/
.sonar-local/
```

## 3. Cobertura de testes (opcional)

Sem cobertura, a análise roda normalmente e a métrica aparece zerada.

**JS/TS (LCOV):** rode os testes com cobertura antes do `scan` (ex.: `vitest run --coverage`,
`jest --coverage`, `ng test --code-coverage`). O `sonar-local` faz o resto:

- se o properties tiver `sonar.javascript.lcov.reportPaths`, usa esses arquivos;
- senão, procura todo `lcov.info` dentro de pastas `coverage/` (fora de `node_modules` e de
  pastas ocultas).

Em seguida, o `sonar-local` reescreve as linhas `SF:` para caminhos relativos à raiz do projeto
e grava as cópias em `.sonar-local/lcov-N.info`. Sem essa correção, a cobertura chegaria
**zerada sem erro nenhum**: os geradores gravam caminhos relativos ao pacote
(`SF:src\api\x.ts`) ou absolutos do Windows, e nenhum dos dois existe dentro do container do
scanner. Use `--sem-cobertura` para pular essa etapa.

**Outras linguagens:** declare o relatório no properties com caminho relativo à raiz, por
exemplo `sonar.python.coverage.reportPaths=coverage.xml`. Ele é repassado sem alteração.

## 4. Analisar

```text
sonar-local scan
```

O comando sobe o servidor se ele estiver parado, cria o projeto no SonarQube na primeira vez,
emite um token de análise restrito ao projeto (o anterior é revogado), roda o scanner num
container, espera o servidor processar e exporta o relatório. Em projetos pequenos, leva menos
de um minuto. Em monorepos TypeScript grandes, de 10 a 15 minutos.

Atalho opcional no `package.json` de projetos Node:

```json
"scripts": {
	"sonar": "sonar-local scan"
}
```

## 5. Ler as orientações

Na pasta `.sonar-local/` (ou na indicada por `--saida`):

| Arquivo | Conteúdo |
| --- | --- |
| `resumo.md` | quality gate (com as condições reprovadas), métricas, contagens por severidade/tipo/regra, arquivos com mais issues |
| `issues.md` | **a lista de trabalho**: cada issue aberta por arquivo e linha, com severidade, regra e mensagem, e no topo cada regra com o link da explicação (por que importa e exemplo de código errado e certo) |
| `issues.json` | issues cruas da Web API (até 10 mil) |
| `hotspots.json` | security hotspots a revisar: código sensível que pede revisão humana, não defeito confirmado |

Fluxo recomendado: corrigir, rodar `sonar-local scan` de novo e conferir. A segunda varredura
também pega atalhos tomados na correção.

**Para agentes de código (Claude Code etc.):** para que um agente use isto por conta própria,
coloque no `CLAUDE.md` ou no README do projeto:

```markdown
## Análise estática (SonarQube local)
Rode `sonar-local scan` na raiz e leia `.sonar-local/issues.md` (issues por arquivo/linha, com
link da regra) e `.sonar-local/resumo.md` (quality gate). Depois de corrigir, rode de novo.
Regra desligada só em `sonar-project.properties` e com o motivo; `// NOSONAR` só com regra e motivo ao lado.
```

## 6. Regras que não se aplicam ao projeto

Quando uma regra conflita com uma convenção **deliberada** do projeto, desligue-a no
properties, sempre com o motivo ao lado:

```properties
# e1 — S7718 (nome do parâmetro do catch): o projeto nomeia em pt-BR (`erro`).
sonar.issue.ignore.multicriteria=e1
sonar.issue.ignore.multicriteria.e1.ruleKey=typescript:S7718
sonar.issue.ignore.multicriteria.e1.resourceKey=**/*
```

No código, `// NOSONAR` só com a regra e o motivo. Um `NOSONAR` sem motivo é dívida escondida.

## 7. Ver os problemas no editor (opcional)

A extensão **SonarQube for IDE** (VS Code, JetBrains) mostra as issues enquanto você edita. Em
*modo conectado*, ela usa as mesmas regras e exclusões do servidor:

1. `sonar-local token meu-editor` emite um token de usuário (guarde, ele só aparece uma vez);
2. na extensão, adicione uma conexão *SonarQube Server* com a URL `http://localhost:9000` e o token;
3. vincule a pasta ao `sonar.projectKey` do projeto.

## Limitações (SonarQube Community)

- **Só uma branch por projeto:** cada `scan` substitui o estado anterior, sem análise de
  branch nem de PR. Para comparar, use o painel, que guarda o histórico e marca o que é
  "código novo".
- **Java/Kotlin:** o scanner precisa das classes compiladas
  (`sonar.java.binaries=target/classes`). Compile antes do `scan`.
- **C#/.NET:** exige o *SonarScanner for .NET*, e não o `sonar-scanner-cli` que este fluxo
  usa. Não é suportado aqui.
- **O scanner só enxerga a pasta do projeto** (montada em `/usr/src`). Links simbólicos que
  apontam para fora dela, ou uma `--saida` fora do projeto, não funcionam.

## Problemas comuns

| Sintoma | Causa e solução |
| --- | --- |
| `Não há sonar-project.properties` | rode na raiz do projeto, ou use `--dir`; crie o arquivo com `sonar-local init` |
| Cobertura 0% com lcov existente | o lcov estava fora de `coverage/` e não foi declarado: declare em `sonar.javascript.lcov.reportPaths` |
| Cobertura 0% e não há lcov | o Vitest não grava o `lcov.info` quando algum teste falha: gere com `npx vitest run --coverage --coverage.reportOnFailure` |
| Scanner cai com crash nativo (bridge do Node, `SIGSEGV` da JVM) | intermitente: rode de novo antes de mexer na configuração ([operacao.md](operacao.md)) |
| Scan TS estoura memória | aumente `sonar.javascript.node.maxspace` (MB) no properties, ex.: `8192` |
| `Falta o .env` / senha não confere | ver [operacao.md](operacao.md) |
| Projeto com chave errada no painel | apague-o em *Administration → Projects → Management* e rode `scan` com a chave certa |
