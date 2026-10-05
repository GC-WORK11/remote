@echo off
rem Windows twin of fake-omp.sh — omprd wraps .cmd binaries via cmd /d /s /c,
rem so this shim just forwards stdin/stdout to the Python fake.
rem Overrides: FAKE_OMP_PY (interpreter), FAKE_N, FAKE_SLEEP_MS.
setlocal
if "%FAKE_OMP_PY%"=="" set "FAKE_OMP_PY=python"
"%FAKE_OMP_PY%" "%~dp0fake-omp.py" %*
