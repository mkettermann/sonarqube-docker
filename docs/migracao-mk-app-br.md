# Migração do mk-app-br para o SonarQube compartilhado

> **Concluída em 2026-11-02.** O `mk-app-br` não tem mais SonarQube próprio e se analisa contra
> este servidor com `pnpm sonar:scan` (= `sonar-local scan --saida temp/sonar`). A documentação do
> lado de lá fica em `docs/master-key-erp/sonarqube.md` daquele repositório.

## O que existia e o que ficou no lugar

| Antes (mk-app-br) | Depois |
| --- | --- |
| projeto Compose `mk-sonar` (`docker-compose.sonar.yml`, containers `mk-sonarqube` e `mk-sonar-db`, volumes `mk-sonar-*`) + `pnpm sonar:up`/`sonar:down` | o servidor deste repositório: `sonar-local up`/`down` (ou nada, porque o `scan` sobe sozinho) |
| `scripts/sonar.mjs` e o teste dele (senha, token, lcov, scanner, relatório) | `sonar-local scan --saida temp/sonar`, que faz tudo isso de forma genérica |
| senha do admin versionada no script | `SONAR_ADMIN_PASSWORD` no `.env` deste repositório (fora do git) |
| `temp/sonar/resumo.md`, `issues.json`, `hotspots.json` | os mesmos, mais `temp/sonar/issues.md` (issues por arquivo e linha) |
| `temp/sonar/lcov-servidor.info`, `lcov-cliente.info` | `temp/sonar/lcov-1.info`, `lcov-2.info` |
| `sonar-project.properties` | o mesmo, com `sonar.javascript.lcov.reportPaths` declarando os dois lcov (o do cliente, `cliente/coverage/MkErpCliente/lcov.info`, é específico do builder do Angular) |

As duas armadilhas que o script antigo tratava continuam tratadas pelo `sonar-local`: o `lcov`
com caminhos relativos ao pacote e o id da tarefa lido da saída do scanner, e não do
`report-task.txt`.

## Como foi feita

- **Histórico:** não foi levado (começou do zero). O projeto `mk-app-br` foi criado pelo
  primeiro `scan` no servidor novo.
- **Primeira varredura:** quality gate OK, 422 issues (2 bugs, 2 vulnerabilidades, 418 code
  smells), 62,0% de cobertura, 203 mil linhas. A diferença para a última do servidor antigo
  (345 issues, 172 mil linhas, 2026-10-03) é código novo, não a troca de servidor.
- **Limpeza:** os containers do `mk-sonar` foram removidos na migração. Os volumes dele não
  servem mais para nada (o histórico não foi levado) e podem ser apagados:

  ```text
  docker volume rm mk-sonar-db-data mk-sonar-data mk-sonar-extensions mk-sonar-logs mk-sonar-scanner-cache
  ```

## O que a migração ensinou

- **Crash nativo do scanner é intermitente.** Num projeto do tamanho do `mk-app-br`, quatro
  varreduras seguidas caíram, cada uma com um erro diferente (`[object Unknown] could not be
  cloned`, `The bridge server is unresponsive`, `v8::FromJust Maybe value is Nothing`, `SIGSEGV`
  da JVM), e a quinta passou sem mudança nenhuma. Rode de novo antes de mexer na configuração;
  aumentar o `sonar.javascript.node.maxspace` não resolveu. Ver [operacao.md](operacao.md).
- **O crash da JVM deixa `hs_err_pid*.log` e `replay_pid*.log` na raiz do projeto** (o
  diretório de trabalho do scanner é o bind mount). O `sonar-local scan` agora move esses
  arquivos para a pasta do relatório.
- **O Vitest não grava o `lcov.info` se algum teste falhar**, e sem ele a cobertura chega
  zerada. Para gerar a cobertura mesmo assim: `npx vitest run --coverage --coverage.reportOnFailure`.
