@echo off
rem Shim do sonar-local para Windows (cmd e PowerShell), independente do Node ativo.
rem Com o fnm instalado, roda o CLI com a versão do .node-version deste repositório,
rem mesmo dentro de projetos que fixam outra versão. Sem fnm, usa o node do PATH.
rem Uso: adicione a pasta bin\ deste repositório ao PATH do usuário (docs/instalacao.md).
setlocal
set "RAIZ=%~dp0.."
set "CLI=%RAIZ%\dist\bin\sonar-local.js"
where fnm >nul 2>nul
if errorlevel 1 goto semFnm
fnm exec --using="%RAIZ%\.node-version" node "%CLI%" %*
exit /b %errorlevel%
:semFnm
node "%CLI%" %*
exit /b %errorlevel%
