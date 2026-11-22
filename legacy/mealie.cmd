@echo off
rem Wrapper so `mealie <command>` works from Command Prompt or PowerShell
rem without changing PowerShell's script execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mealie.ps1" %*
