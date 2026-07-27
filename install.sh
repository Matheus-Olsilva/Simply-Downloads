#!/usr/bin/env bash
# Instala as dependências do Baixador de Vídeos Universal.
# - ffmpeg: via apt (sudo) — necessário para remuxar HLS em .mp4 puro
# - yt-dlp + flask: via pip --user (Python 3.14 é "externally-managed",
#   por isso usamos --break-system-packages, escopo isolado do usuário)
set -e

echo "==> [1/2] Instalando ffmpeg (sudo apt-get)..."
sudo apt-get update -y
sudo apt-get install -y ffmpeg

echo "==> [2/2] Instalando yt-dlp e flask (pip --user)..."
pip3 install --user --break-system-packages --upgrade yt-dlp flask

echo "==> Validando..."
python3 -c "import yt_dlp, flask; print('yt-dlp', yt_dlp.version.__version__, '| flask ok')"
ffmpeg -version | head -1

echo ""
echo "✅ Pronto. Rode:  python3 app.py   →   http://127.0.0.1:5000"