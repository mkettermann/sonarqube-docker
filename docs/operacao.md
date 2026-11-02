# Operação do servidor

Tarefas do dia a dia e manutenção do SonarQube compartilhado. Os comandos com `docker compose`
rodam na pasta deste repositório.

## Subir, derrubar, acompanhar

```text
sonar-local status        # UP / STARTING / não responde
sonar-local up            # = docker compose up -d
sonar-local down          # = docker compose down (os dados ficam)
npm run logs              # = docker compose logs -f sonarqube
```

Não é preciso subir manualmente antes de analisar: o `sonar-local scan` sobe o servidor se ele
não responder. Com `restart: unless-stopped`, os containers voltam sozinhos quando o Docker
inicia, exceto se foram derrubados com `down`.

## Onde ficam os dados

| Volume | Conteúdo |
| --- | --- |
| `sonarqube-local-db-data` | Postgres: projetos, histórico de análises, usuários, tokens, configurações |
| `sonarqube-local-data` | índices do Elasticsearch (reconstruíveis a partir do banco) |
| `sonarqube-local-extensions` | plugins instalados pelo painel |
| `sonarqube-local-logs` | logs do servidor |
| `sonarqube-local-scanner-cache` | cache de plugins do scanner (descartável) |

`docker compose down` mantém tudo. `docker compose down -v` **apaga** os quatro primeiros e
zera o servidor: a senha volta a `admin`/`admin` e o próximo `sonar-local setup` ou `scan`
a redefine pelo `.env`.

## Backup e restauração

O que importa é o banco:

```text
docker exec sonarqube-local-db pg_dump -U sonar -d sonarqube -Fc -f /tmp/sonar.dump
docker cp sonarqube-local-db:/tmp/sonar.dump ./sonar.dump
```

Para restaurar num servidor novo, suba só o banco e restaure antes de subir o SonarQube:

```text
docker compose up -d sonarqube-db
docker cp ./sonar.dump sonarqube-local-db:/tmp/sonar.dump
docker exec sonarqube-local-db pg_restore -U sonar -d sonarqube --clean --if-exists /tmp/sonar.dump
docker compose up -d
```

O dump precisa ser da mesma versão do SonarQube, ou de uma anterior, que ele migra na subida.

## Atualizar o SonarQube

A imagem padrão é `sonarqube:community`, uma tag móvel que aponta para a versão mais recente.
Para atualizar:

```text
# 1. faça o backup do banco (acima)
docker compose pull
docker compose up -d
sonar-local status
```

Se o status ficar em `DB_MIGRATION_NEEDED`, abra <http://localhost:9000/setup> e confirme a
migração. O `sonar-local` avisa quando cai nesse caso.

Para controlar quando atualizar, fixe a versão no `.env`
(`SONARQUBE_IMAGE=sonarqube:<versão>-community`, conforme as tags do Docker Hub). O SonarQube
não volta de versão: para desfazer uma atualização, restaure o backup feito antes dela.

O Postgres fica fixo na versão 16. Trocar a versão **maior** do Postgres exige dump e restore,
pois o volume de dados não é compatível entre versões maiores.

## Trocar a senha do admin

1. no painel: *My Account → Security → Change password*;
2. atualize `SONAR_ADMIN_PASSWORD` no `.env` com a mesma senha.

### A senha do admin não confere

O erro *"A senha do admin no .env não confere com a do servidor"* aparece quando a senha foi
trocada pelo painel e o `.env` não foi atualizado, ou o contrário. Corrija o `.env` com a senha
atual. Se ninguém lembrar a senha e o histórico não importar, zere o servidor com
`docker compose down -v`.

## Problemas comuns

| Sintoma | Causa e solução |
| --- | --- |
| `port is already allocated` ao subir | outra coisa usa a porta: troque `SONAR_PORT` no `.env` |
| Fica em `STARTING` e o container reinicia | memória insuficiente para o Docker: veja os logs e aumente a memória da VM (≥ 4 GB) |
| `max virtual memory areas vm.max_map_count [65530] is too low` | o `SONAR_SEARCH_JAVAADDITIONALOPTS` foi removido do compose: ele precisa continuar lá |
| `docker não encontrado no PATH` | o Docker Desktop não está instalado ou não foi iniciado |
| `Falta o .env` | copie `.env.example` para `.env` e defina a senha ([instalacao.md](instalacao.md)) |
| Avisos `Unable to rename … fileCache` no scanner | inofensivos: o cache do scanner é um volume, e na primeira execução o rename atômico falha |
