@echo off
call npm ci
call npx playwright install chromium
