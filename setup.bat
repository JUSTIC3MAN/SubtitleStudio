@echo off
setlocal enabledelayedexpansion
title Subtitle Studio - setup
cd /d "%~dp0"

set "CUDA=%~1"
if "%CUDA%"=="" set "CUDA=cu128"

echo.
echo    Subtitle Studio - first-time setup
echo    ==================================================
echo    Installs PyTorch (%CUDA%), the speech models' code and the
echo    web server into a private "venv" folder here, then downloads
echo    the models (about 7 GB). Expect 10-25 minutes, once.
echo.
echo    Older NVIDIA driver?  close this and run:  setup.bat cu126
echo.

rem ---- find Python 3.12 (3.10-3.13 also work) -----------------------------
set "PY="
py -3.12 -c "import sys" >nul 2>&1 && set "PY=py -3.12"
if not defined PY py -3.11 -c "import sys" >nul 2>&1 && set "PY=py -3.11"
if not defined PY py -3.13 -c "import sys" >nul 2>&1 && set "PY=py -3.13"
if not defined PY if exist "C:\Program Files\Python312\python.exe" set "PY="C:\Program Files\Python312\python.exe""
if not defined PY (
    python -c "import sys;raise SystemExit(0 if (3,10)<=sys.version_info[:2]<=(3,13) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
    echo    Python 3.12 was not found.
    echo    Install it from https://www.python.org/downloads/release/python-3129/
    echo    and tick "Add python.exe to PATH".
    goto :fail
)
echo    Using: %PY%

if not exist "venv\Scripts\python.exe" (
    echo.
    echo    Creating the private Python environment...
    %PY% -m venv venv || goto :fail
)
call venv\Scripts\activate.bat
python -m pip install --upgrade pip --quiet

echo.
echo    [1/3] PyTorch with CUDA (%CUDA%) - about 3 GB...
rem 2.11 is the build RapSubtitles already runs on this PC, and it pairs with
rem the transformers version qwen-asr needs. Fall back to the newest if it's gone.
pip install torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/%CUDA%
if errorlevel 1 (
    echo    Pinned PyTorch not available - installing the newest CUDA build instead...
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/%CUDA% || goto :fail
)
python -c "import torch;print('          torch', torch.__version__, '| GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE')"

rem pin the CUDA build so later installs cannot replace it with a CPU one
pip freeze | findstr /b /i "torch" > constraints.txt

echo.
echo    [2/3] Speech recognition, vocal isolation and the web server...
pip install -r requirements.txt -c constraints.txt || goto :fail

echo.
echo    [3/3] Downloading the models (about 7 GB)...
python tools\download_models.py

echo.
echo    Setup finished.
echo    Check it any time with:  venv\Scripts\python tools\check_setup.py
echo.
exit /b 0

:fail
echo.
echo    Setup stopped - the reason is in the lines above.
echo    Fix it and run setup.bat again; finished steps are skipped.
echo.
exit /b 1
