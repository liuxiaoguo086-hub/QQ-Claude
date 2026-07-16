@echo off
cd /d "%~dp0"
REM 将 Git Bash 加入 PATH，确保 Node.js 能找到 bash.exe
set "PATH=D:\Git\bin;%PATH%"
REM ===== 在下方填入你的 DeepSeek API Key =====
set "ANTHROPIC_AUTH_TOKEN=填入你的API_Key"
REM =============================================
node index.js --daemon
