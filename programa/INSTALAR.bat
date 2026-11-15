@echo off
title Instalar Sistema del Restaurante
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
pause
