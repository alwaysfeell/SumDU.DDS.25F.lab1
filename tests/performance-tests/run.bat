@echo off
set "NAME=%~1"
if "%NAME%"=="" set "NAME=smoke-test"
if not exist "tests\%NAME%.js" (
  echo File tests\%NAME%.js not found. Run this script from the tests\performance-tests folder.
  exit /b 1
)
set K6_WEB_DASHBOARD=true
set K6_WEB_DASHBOARD_OPEN=true
set K6_WEB_DASHBOARD_EXPORT=reports\%NAME%-dashboard.html
k6 run tests\%NAME%.js
