@echo off
rem Windows twin of tools/omp-fork.sh — run the vendored omp fork from source.
rem Point omprd's --omp-bin at this .cmd (daemon wraps .cmd via cmd /d /s /c).
rem Overrides: OMP_FORK_DIR (fork checkout), BUN (bun binary).
setlocal
set "HERE=%~dp0"
if "%OMP_FORK_DIR%"=="" set "OMP_FORK_DIR=%HERE%..\..\engine\omp"
if "%BUN%"=="" set "BUN=bun"
rem No --cwd: the agent's tools must run in the session cwd omprd spawned us
rem in, not packages/coding-agent. Absolute entry resolves the workspace.
"%BUN%" "%OMP_FORK_DIR%\packages\coding-agent\src\cli.ts" %*
