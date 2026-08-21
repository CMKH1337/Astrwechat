@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title AstrWeChat

echo.
echo ========================================
echo   欢迎使用 AstrWeChat喵
echo ========================================
echo 正在检查依赖并启动程序喵。
echo 首次启动需要安装依赖，稍安勿躁喵。
echo.

echo [1/4] 正在检查 Node.js 环境喵...
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请安装 Node.js 20 或更高版本后重试喵。
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm.cmd。请重新安装 Node.js 后重试喵。
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo [2/4] 检测到首次启动，正在安装 Node.js 依赖喵...
  echo       请保持此窗口打开，直到安装完成喵。
  call npm.cmd install
  if errorlevel 1 (
    echo [错误] Node.js 依赖安装失败喵。
    pause
    exit /b 1
  )
) else (
  echo [2/4] Node.js 依赖已就绪喵。
)

echo [3/4] 正在查找 Bridge 所需的 Python 环境喵...
set "PYTHON_CMD="
if exist ".venv\Scripts\python.exe" (
  set "PYTHON_CMD=.venv\Scripts\python.exe"
) else (
  where py >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
  ) else (
    where python >nul 2>nul
    if not errorlevel 1 set "PYTHON_CMD=python"
  )
)

if not defined PYTHON_CMD (
  echo [警告] 未找到 Python。界面可启动，但 Bridge 无法运行喵。
  echo        请安装 Python 3.10 或更高版本后重新运行此文件喵。
) else (
  echo       已找到 Python: %PYTHON_CMD% 喵。
  echo       正在安装或检查 Bridge Python 依赖喵...
  %PYTHON_CMD% -m pip install -r bridge\requirements.txt
  if errorlevel 1 (
    echo [错误] Bridge Python 依赖安装失败喵。
    pause
    exit /b 1
  )
)

echo.
rem Always start the built runtime; do not inherit a Vite development server URL.
set "VITE_DEV_SERVER_URL="
set "WEFLOW_FORCE_PRODUCTION=1"
set "NODE_ENV=production"
echo [4/4] 正在启动 AstrWeChat 喵...
echo       编译完成后将自动打开程序窗口喵。
echo       请保持此窗口打开；按 Ctrl+C 可停止程序喵。
echo.
call npm.cmd run electron:run

set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo [已停止] WeFlow Bridge 已退出，退出代码：%EXIT_CODE% 喵。
pause
exit /b %EXIT_CODE%
