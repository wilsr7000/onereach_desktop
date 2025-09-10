@echo off
REM Windows build script for Onereach.ai

echo Building Onereach.ai for Windows...
echo.

REM Clean previous builds
if exist dist rmdir /s /q dist

REM Build for Windows
echo Building Windows x64...
call npm run package:win:x64

echo.
echo Build complete! Check the dist folder for:
echo - Onereach.ai Setup *.exe (installer)
echo.

REM Note: Windows doesn't require code signing for development
REM For production, you would use a code signing certificate with signtool.exe 