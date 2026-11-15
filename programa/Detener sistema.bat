@echo off
title Detener Sistema del Restaurante
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detener.ps1"
pause
