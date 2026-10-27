@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  启动「固定 4K」版抖音 PC 客户端（CDP 路线，参考实现）
rem  1) 先确认抖音已完全退出（单实例运行会导致新参数无效）
rem  2) 带 --remote-debugging-port 启动
rem  3) 用 CDP 注入 payload.js（不改客户端文件）
rem
rem  !! 8.7.0 实测：客户端不接受这个调试端口（端口不 listen），
rem     本脚本在 8.7.0 上不会生效。请改用 install-preload.ps1。
rem     保留它是因为逻辑完整：将来客户端放开调试口，双击即可使用。
rem ============================================================

set "PORT=92258"
set "DOUYIN=D:\软件\抖音\douyin\douyin.exe"
set "HERE=%~dp0"

if not exist "%DOUYIN%" (
  echo [!] 找不到抖音: %DOUYIN%
  echo     请修改本文件里的 DOUYIN 变量。
  pause & exit /b 1
)

tasklist /fi "imagename eq douyin.exe" 2>nul | find /i "douyin.exe" >nul
if not errorlevel 1 (
  echo [!] 抖音正在运行，请先从托盘完全退出（右键托盘图标 - 退出）。
  echo     单实例机制会让这次的调试端口参数被忽略。
  pause & exit /b 1
)

echo [*] 启动抖音: %DOUYIN%  (debug port %PORT%)
start "" "%DOUYIN%" --remote-debugging-port=%PORT%

echo [*] 等待调试端口就绪...
set /a N=0
:wait
timeout /t 1 >nul
set /a N+=1
curl -s -m 1 "http://127.0.0.1:%PORT%/json/version" >nul 2>&1
if not errorlevel 1 goto ready
if %N% geq 30 (
  echo [!] 30 秒内端口没起来。可能抖音拒绝了该参数，或杀软拦截。
  pause & exit /b 1
)
goto wait

:ready
echo [*] 端口就绪，开始注入（窗口保持最小化即可，关掉它抖音也会失去 4K 锁定）
start "dypc4k injector" /min cmd /c node "%HERE%inject.mjs" --port %PORT%
echo [*] 完成。抖音里点一个视频，清晰度应显示「超清 4K」。
echo     校验：node "%HERE%inject.mjs" --port %PORT% --verify
timeout /t 5 >nul
exit /b 0
