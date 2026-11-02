# Migração do mk-app-br para o SonarQube compartilhado

Hoje o `mk-app-br` tem um SonarQube próprio: o projeto Compose `mk-sonar`
(`docker-compose.sonar.yml`, containers `mk-sonarqube` e `mk-sonar-db`, volumes `mk-sonar-*`),
orquestrado por `scripts/sonar.mjs`. Este guia aposenta esse servidor e passa o `mk-app-br` a
usar o `sonar-local`. O fluxo continua o mesmo, e o relatório fica no mesmo lugar
(`temp/sonar/`).

## O que muda e o que fica

| Antes (mk-app-br) | Depois |
| --- | --- |
| `docker-compose.sonar.yml` + `pnpm sonar:up`/`sonar:down` | o servidor deste repositório: `sonar-local up`/`down` (ou nada, porque o `scan` sobe sozinho) |
| `scripts/sonar.mjs` (senha, token, lcov, scanner, relatório) | `sonar-local scan --saida temp/sonar` faz tudo isso, de forma genérica |
| senha `MkSonar@Dev2026` versionada no script | `SONAR_ADMIN_PASSWORD` no `.env` deste repositório (fora do git) |
| `temp/sonar/resumo.md`, `issues.json`, `hotspots.json` | os mesmos, mais `temp/sonar/issues.md` (issues por arquivo e linha) |
| `temp/sonar/lcov-servidor.info`, `lcov-cliente.info` | `temp/sonar/lcov-1.info`, `lcov-2.info` |
| `sonar-project.properties` | o mesmo arquivo, com uma linha a mais (abaixo) |

As duas armadilhas tratadas pelo script antigo continuam tratadas: o `lcov` com caminhos
relativos ao pacote e o id da tarefa lido da saída do scanner, e não do `report-task.txt`.

## Passo 1: instalar este repositório

Siga [instalacao.md](instalacao.md). Para preservar o histórico (passo 2, opção B), use no
`.env` a mesma senha do servidor antigo: `SONAR_ADMIN_PASSWORD=MkSonar@Dev2026`.

Os dois servidores não sobem juntos na porta 9000. Para testar este enquanto o antigo ainda
roda, use temporariamente `SONAR_PORT=9001` no `.env`.

## Passo 2: histórico de análises

**Opção A, começar do zero (recomendado):** não faça nada. O primeiro `scan` cria o projeto
`mk-app-br` no servidor novo. Perde-se só o gráfico de evolução das análises anteriores. As
issues reaparecem na próxima varredura.

**Opção B, levar o histórico:** copie os volumes antigos para os novos **antes** do primeiro
start do servidor novo. As duas imagens precisam ser da mesma versão do SonarQube; com a tag
`sonarqube:community` já baixada, são.

```text
cd C:\PROJETOS\mk-app-br
docker compose -f docker-compose.sonar.yml down

cd C:\PROJETOS\sonarqube-docker
docker compose down -v          # garante que os volumes novos estão vazios (APAGA o que houver neles)
docker compose create           # cria containers e volumes vazios, sem iniciar nada
docker run --rm -v mk-sonar-db-data:/de -v sonarqube-local-db-data:/para alpine sh -c "cp -a /de/. /para/"
docker run --rm -v mk-sonar-data:/de -v sonarqube-local-data:/para alpine sh -c "cp -a /de/. /para/"
docker run --rm -v mk-sonar-extensions:/de -v sonarqube-local-extensions:/para alpine sh -c "cp -a /de/. /para/"
sonar-local setup               # sobe com os dados copiados; a senha já é a do .env
```

Se o `setup` reclamar da senha, o `.env` não está com `MkSonar@Dev2026`.

## Passo 3: desligar o servidor antigo

```text
cd C:\PROJETOS\mk-app-br
docker compose -f docker-compose.sonar.yml down
```

Volte o `.env` para `SONAR_PORT=9000`, se tiver mudado, e rode `sonar-local setup`.

Depois de conferir que o novo funciona (passo 5), apague os restos:

```text
docker volume rm mk-sonar-db-data mk-sonar-data mk-sonar-extensions mk-sonar-logs mk-sonar-scanner-cache
```

## Passo 4: alterações no repositório mk-app-br

1. **Apagar** `docker-compose.sonar.yml`, `scripts/sonar.mjs` e o teste dele,
   `servidor/src/testing/sonar-script.test.ts`.
2. **`package.json`**, nos scripts:

   ```json
   "sonar:up": "sonar-local up",
   "sonar:down": "sonar-local down",
   "sonar:scan": "sonar-local scan --saida temp/sonar",
   "sonar:report": "sonar-local report --saida temp/sonar"
   ```

3. **`sonar-project.properties`**: declare os lcov, porque o caminho do cliente é específico
   do builder do Angular, e atualize o comentário do cabeçalho, que cita o `scripts/sonar.mjs`:

   ```properties
   sonar.javascript.lcov.reportPaths=servidor/coverage/lcov.info,cliente/coverage/MkErpCliente/lcov.info
   ```

   O resto (fontes, exclusões, regras desligadas, `tsconfigPaths`, `maxspace`) fica como está.
4. **Documentação:** em `docs/master-key-erp/sonarqube.md`, reescrever as seções 1 a 3
   (comandos, credenciais e "como funciona") apontando para este repositório; na seção 4,
   acrescentar o `issues.md`. Atualizar também a linha do SonarQube no `CLAUDE.md` e a seção
   de SonarQube do `zzz_ComandosUteis.md`. As seções de regras desligadas e da primeira
   varredura continuam válidas.
5. **`.gitignore`:** nada a mudar. `.scannerwork/` e `temp/` já estão lá.

## Passo 5: conferir

```text
cd C:\PROJETOS\mk-app-br
pnpm --filter mkerp-servidor test:coverage
pnpm --filter mk-cliente-angular test:coverage
pnpm sonar:scan
```

Confira no `temp/sonar/resumo.md` que a **cobertura não está zerada**, porque é a falha que
acontece em silêncio, e que a contagem de issues bate com a última varredura do servidor
antigo, desconsiderando o que foi corrigido desde então.
