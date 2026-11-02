# Instalação num computador novo

Passo a passo para deixar o SonarQube compartilhado rodando numa máquina e o comando
`sonar-local` disponível para todos os projetos dela. Feito uma vez por computador.

## 1. Pré-requisitos

| Item | Versão | Observação |
| --- | --- | --- |
| Docker | Docker Desktop (Windows/macOS) ou Docker Engine + Compose v2 (Linux) | no Windows, com o backend WSL2 |
| Node.js | 20 ou superior | só para o CLI `sonar-local` (zero dependências) |
| Git | qualquer | para clonar este repositório |

**Memória:** o SonarQube (com o Elasticsearch embutido) usa de 2 a 3 GB. No Docker Desktop,
confira em *Settings → Resources* que a VM tem pelo menos 4 GB. No WSL2, o limite fica no
`.wslconfig`.

**Iniciar com o sistema:** os containers usam `restart: unless-stopped`, então voltam sozinhos
quando o Docker inicia. No Docker Desktop, ative *Settings → General → Start Docker Desktop
when you sign in* para o SonarQube estar no ar depois de reiniciar o computador.

> Não é preciso ajustar `vm.max_map_count`. O compose desliga o `mmap` do Elasticsearch
> (`-Dnode.store.allow_mmap=false`), que é o que exigiria esse ajuste no kernel (e que no
> WSL2 não persiste).

## 2. Clonar o repositório

Em qualquer pasta. Os exemplos usam `C:\PROJETOS`:

```text
cd C:\PROJETOS
git clone <url-deste-repositório> sonarqube-docker
cd sonarqube-docker
```

## 3. Criar o `.env`

```text
copy .env.example .env        # Windows (cmd/PowerShell)
cp .env.example .env          # Linux/macOS/Git Bash
```

Edite o `.env` e defina **`SONAR_ADMIN_PASSWORD`**. O SonarQube exige pelo menos 12
caracteres, com maiúscula, minúscula, número e caractere especial. Essa é a senha do usuário
`admin` no painel; o `sonar-local` a aplica sozinho no primeiro uso.

Se a porta 9000 já estiver ocupada na máquina, troque `SONAR_PORT`. O CLI e o compose leem o
mesmo valor.

## 4. Instalar o comando `sonar-local`

Na pasta do repositório:

```text
npm link
```

Isso cria o comando global `sonar-local`, um link para `bin/sonar-local.mjs`. Ele encontra o
`.env` e o `docker-compose.yml` deste repositório sozinho, a partir de qualquer pasta. Por
ser um link, um `git pull` aqui já atualiza o comando. Confira com `sonar-local help`.

> Sem `npm link`, use o caminho completo: `node C:\PROJETOS\sonarqube-docker\bin\sonar-local.mjs <comando>`.

## 5. Subir e configurar

```text
sonar-local setup
```

O comando sobe o `docker compose` (baixa as imagens na primeira vez), espera o SonarQube ficar
`UP` (de 1 a 2 minutos no primeiro start) e troca a senha padrão `admin`/`admin` pela do `.env`.

⚠️ Rode o `setup` **antes** de abrir o painel no navegador. Se você entrar com `admin`/`admin`
e trocar a senha manualmente, ela precisa ser igual à do `.env` (senão, ver
[operacao.md](operacao.md#a-senha-do-admin-não-confere)).

Depois, abra <http://localhost:9000> e entre com `admin` e a senha do `.env`.

## 6. Conferir de ponta a ponta

```text
sonar-local status            # → http://localhost:9000 — UP
cd C:\PROJETOS\algum-projeto
sonar-local init
sonar-local scan
```

O primeiro `scan` baixa a imagem do scanner e os plugins de análise, que ficam guardados no
volume `sonarqube-local-scanner-cache` para os próximos. A partir daqui, siga
[novo-projeto.md](novo-projeto.md) para cada projeto.

## Desinstalar

```text
cd C:\PROJETOS\sonarqube-docker
npm unlink -g sonarqube-docker              # remove o comando sonar-local
docker compose down -v                      # derruba e APAGA os dados (histórico de análises)
docker volume rm sonarqube-local-scanner-cache
```
