# sonarqube-docker

Um **SonarQube local compartilhado** por todos os projetos do computador. Um único servidor
roda em Docker, e qualquer projeto da máquina se analisa contra ele com um comando, recebendo
de volta um relatório em Markdown com o que melhorar: cada issue com arquivo, linha, regra e
link para a explicação.

```text
┌──────────────── este repositório ────────────────┐
│ docker-compose.yml   (projeto Compose sonarqube-local)
│   sonarqube-local     SonarQube Community  → http://localhost:9000 (só 127.0.0.1)
│   sonarqube-local-db  Postgres 16
│   rede sonarqube-local-net + volumes sonarqube-local-*
│ bin/sonar-local.mjs  CLI global `sonar-local` (Node, zero dependências)
└──────────────────────────────────────────────────┘
          ▲ API (senha do admin no .env)       ▲ rede Docker
          │                                    │
  projeto-x/  $ sonar-local scan  ──►  container sonar-scanner-cli (projeto montado em /usr/src)
          └──► projeto-x/.sonar-local/resumo.md, issues.md, issues.json, hotspots.json
```

Os projetos analisados **não** sobem SonarQube nem instalam Java ou scanner. Eles só precisam
de um `sonar-project.properties` e do comando `sonar-local`.

> Somente desenvolvimento: o painel fica publicado apenas em `127.0.0.1`, e as credenciais
> ficam no `.env` local (fora do git).

## Uso rápido (máquina já instalada)

```text
cd C:\PROJETOS\meu-projeto
sonar-local init          # 1ª vez: cria o sonar-project.properties (ajuste sonar.sources)
sonar-local scan          # sobe o servidor se preciso, analisa e exporta o relatório
```

Depois, leia `.sonar-local/issues.md` (a lista do que corrigir) e `.sonar-local/resumo.md`
(quality gate e métricas). O painel completo fica em <http://localhost:9000> (login `admin`,
senha `SONAR_ADMIN_PASSWORD` do `.env` deste repositório).

## Documentação

| Guia | Para quê |
| --- | --- |
| [docs/instalacao.md](docs/instalacao.md) | instalar tudo num computador novo (Docker, `.env`, `npm link`, primeiro start) |
| [docs/novo-projeto.md](docs/novo-projeto.md) | colocar um projeto para ser analisado, ler o relatório e integrar com o editor |
| [docs/operacao.md](docs/operacao.md) | dia a dia: subir/derrubar, backup, atualizar o SonarQube, trocar senha, problemas comuns |
| [docs/migracao-mk-app-br.md](docs/migracao-mk-app-br.md) | aposentar o SonarQube próprio do `mk-app-br` e passar a usar este |

## Comandos

| Comando | O que faz |
| --- | --- |
| `sonar-local init [chave]` | cria o `sonar-project.properties` no projeto atual a partir de [templates/](templates/sonar-project.properties) |
| `sonar-local scan` | analisa o projeto atual e exporta o relatório para `.sonar-local/` |
| `sonar-local report` | só reexporta o relatório da última análise |
| `sonar-local token [nome]` | emite um token de usuário (ex.: SonarQube for IDE em modo conectado) |
| `sonar-local setup` | sobe o servidor, se preciso, e define a senha do admin pelo `.env` |
| `sonar-local up` / `down` / `status` | sobe, derruba ou consulta o servidor |

Opções: `--dir <pasta>` (projeto, padrão a pasta atual), `--saida <pasta>` (relatório, padrão
`.sonar-local`), `--sem-cobertura`, e `-- <args>` para repassar ao scanner
(ex.: `sonar-local scan -- -Dsonar.verbose=true`).

Na pasta deste repositório também há `npm run up`, `npm run down`, `npm run logs`,
`npm run status` e `npm test` (testes do CLI).

## Estrutura

```text
docker-compose.yml               SonarQube + Postgres (projeto Compose sonarqube-local)
.env.example                     modelo do .env (porta, senha do admin, imagens)
bin/sonar-local.mjs              CLI (comandos e mensagens)
lib/config.mjs                   .env, sonar-project.properties, argumentos
lib/servidor.mjs                 Web API: subir, senha do admin, projeto, token, tarefa
lib/scanner.mjs                  docker run do sonar-scanner-cli
lib/cobertura.mjs                acha os lcov.info e corrige os caminhos
lib/relatorio.mjs                resumo.md / issues.md / *.json
templates/sonar-project.properties  modelo para projetos novos
test/                            testes (node --test)
```
