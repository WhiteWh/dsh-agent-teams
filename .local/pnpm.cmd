@echo off
rem Run the package manager this repository pins, without touching the global
rem npm install and without writing outside the workspace.
rem
rem CI (.github/workflows/verify.yml) does `npm install --global pnpm@10.33.0`
rem then `pnpm install --frozen-lockfile`. Two facts about this machine make the
rem direct route unusable, so this wrapper exists:
rem   * `npm install --global` needs C:\Users\<user>\AppData\Local\npm-cache,
rem     which the confined pwsh sandbox cannot write (EPERM);
rem   * npx reads/writes the same cache directory, so npm_config_cache has to be
rem     redirected into the workspace on every invocation, not just once.
rem Call it from the repository root:
rem   .local\pnpm.cmd install --frozen-lockfile
rem   .local\pnpm.cmd typecheck
rem   .local\pnpm.cmd build
rem   .local\pnpm.cmd verify
setlocal
set "npm_config_cache=D:\OwlCats\AI_Tools\.npm-cache"
rem pnpm refuses to purge a modules directory written by another major version
rem unless it can prompt; this says "not interactive, proceed".
set "CI=true"
call npx --yes pnpm@10.33.0 %*
exit /b %ERRORLEVEL%
