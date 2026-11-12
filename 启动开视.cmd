@echo off
cd /d "%~dp0"
node server\launch.mjs
if errorlevel 1 pause
