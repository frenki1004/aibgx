@echo off
REM Civilization Clash - Install dependencies and start servers
REM Usage: install_and_start.bat [server flags...]
REM Example: install_and_start.bat --tournament --no-fog

cd /d "%~dp0"

REM Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Error: Node.js is not installed. Download it from https://nodejs.org/
    exit /b 1
)

for /f %%v in ('node -e "console.log(process.versions.node.split('.')[0])"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
    echo Error: Node.js 22+ required. Download the latest from https://nodejs.org/
    exit /b 1
)

REM Install server dependencies
echo Installing server dependencies...
cd server && call npm install --silent && cd ..

REM Start frontend in background
start /b node visuals/serve.js

echo.
echo === Civilization Clash ===
echo Game server:  ws://localhost:8080
echo Frontend:     http://localhost:3000
echo Press Ctrl+C to stop
echo.

REM Game server in foreground (Ctrl+C kills it)
node server/server.js %*

REM After exit, kill anything left on ports 8080 and 3000
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8080.*LISTENING"') do taskkill /f /pid %%p >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000.*LISTENING"') do taskkill /f /pid %%p >nul 2>&1
