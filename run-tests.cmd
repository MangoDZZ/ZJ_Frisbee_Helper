@echo off
rem Run all offline tests (algorithm + cloud functions + page checks).
rem Double-click this file, or run it from a terminal.
rem
rem Falls back to the Node runtime bundled with VS Code when Node is not installed.
rem
rem NOTE: keep this file ASCII-only. cmd.exe reads .cmd in the system codepage
rem (GBK here), so UTF-8 comments get mangled badly enough to break parsing.
rem
rem Uses goto instead of parenthesised blocks: cmd expands %vars% inside a block
rem before entering it, which breaks paths containing spaces.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto try_vscode

echo [using system Node]
echo.
node tests\run-all.js
goto done

:try_vscode
if not exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" goto no_node

echo [Node not found - using the Node runtime bundled with VS Code]
echo.
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests\run-all.js
goto done

:no_node
echo.
echo Neither Node.js nor VS Code was found.
echo Install Node.js: https://nodejs.org
echo.
pause
exit /b 1

:done
echo.
pause
