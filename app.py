#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Baixador de Vídeos Universal — servidor Flask + yt-dlp.

Roda apenas em 127.0.0.1. Nada é exposto para a rede.
"""
import os
import json
import uuid
import hashlib
import subprocess
import threading
import queue as _queue
import time
import re
import html as _html
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from pathlib import Path

from flask import Flask, request, jsonify, Response, render_template, send_from_directory

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

# --------------------------------------------------------------------------- #
# Configuração
# --------------------------------------------------------------------------- #
HOST = "127.0.0.1"
PORT = 5000
HOME = str(Path.home())
BASE = os.path.dirname(os.path.abspath(__file__))
LIBRARY_FILE = os.path.join(BASE, "library.json")
CONFIG_FILE = os.path.join(BASE, "config.json")
FOLDERS_CONFIG_FILE = os.path.join(BASE, "folders_config.json")
THUMB_DIR = os.path.join(BASE, ".thumbs")

VIDEO_EXTS = {
    ".mp4", ".mkv", ".webm", ".ts", ".avi", ".mov", ".m4v",
    ".mpg", ".mpeg", ".flv", ".wmv", ".3gp", ".ogv",
}

app = Flask(__name__, template_folder="templates", static_folder="static")

# Estado dos jobs: job_id -> dict
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

# Pastas da biblioteca (persistidas em library.json) — lista de paths.
LIBRARY: list[str] = []
LIB_LOCK = threading.Lock()

# Configurações persistidas (config.json).
CONFIG: dict = {"default_out_dir": HOME}
CONFIG_LOCK = threading.Lock()

# Configurações de privacidade das pastas (folders_config.json)
FOLDERS_CONFIG: dict = {}
FOLDERS_CONFIG_LOCK = threading.Lock()
UNLOCKED_FOLDERS: set[str] = set()

PLAYCACHE_DIR = os.path.join(BASE, ".playcache")
_thumb_lock = threading.Lock()
_play_locks: dict[str, threading.Lock] = {}
_play_locks_guard = threading.Lock()


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def safe_dir(path: str) -> str:
    """Normaliza e valida que é um diretório existente/acessível."""
    if not path:
        return HOME
    p = os.path.abspath(os.path.expanduser(path))
    return p


def list_dirs(path: str):
    """Lista subdiretórios de path (sem seguir symlinks quebrados)."""
    path = safe_dir(path)
    if not os.path.isdir(path):
        return [], path
    try:
        entries = sorted(os.listdir(path))
    except (PermissionError, OSError):
        return [], path
    dirs = []
    for name in entries:
        if name.startswith("."):
            continue
        full = os.path.join(path, name)
        try:
            is_dir = os.path.isdir(full) and not os.path.islink(full)
        except OSError:
            continue
        if is_dir:
            dirs.append(name)
    return dirs, path


def get_mounts():
    """Retorna pontos de montagem acessíveis (HD externo, pendrive, /, /home...)."""
    out = []
    seen = set()
    try:
        with open("/proc/mounts", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 2:
                    continue
                dev, mnt = parts[0], parts[1]
                # ignora pseudo-filesystems
                if any(x in dev for x in ("proc", "sysfs", "tmpfs", "devtmpfs",
                                          "cgroup", "mqueue", "squashfs")):
                    continue
                mnt = mnt.replace("\\040", " ").replace("\\011", "\t")
                if mnt in seen:
                    continue
                if os.path.isdir(mnt) and os.access(mnt, os.R_OK):
                    seen.add(mnt)
                    out.append(mnt)
    except OSError:
        pass
    # garante pelo menos raiz e home
    for p in ("/", HOME):
        if p not in seen and os.path.isdir(p):
            out.append(p)
    out.sort()
    return out


def list_videos(path: str):
    """Lista arquivos de vídeo em path (não recursivo)."""
    path = safe_dir(path)
    if not os.path.isdir(path):
        return [], path
    try:
        entries = os.listdir(path)
    except (PermissionError, OSError):
        return [], path
    videos = []
    for name in entries:
        if name.startswith("."):
            continue
        full = os.path.join(path, name)
        try:
            if not os.path.isfile(full):
                continue
            st = os.stat(full)
        except OSError:
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in VIDEO_EXTS:
            continue
        videos.append({
            "name": name,
            "path": full,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "ext": ext,
        })
    # A tela inicial usa esta mesma resposta da API; manter a ordenação aqui
    # garante que os vídeos mais novos apareçam primeiro em todos os lugares.
    videos.sort(key=lambda video: (video["mtime"], video["name"].lower()), reverse=True)
    return videos, path


# ---- fallback para páginas que não têm extrator no yt-dlp ----
_MEDIA_RE = re.compile(
    r"(?:https?:)?//[^\"'<>\\ ]+|(?:[^\"'<>\\ ]+\.(?:m3u8|mp4|webm|mpd)(?:\?[^\"'<>\\ ]*)?)",
    re.IGNORECASE,
)


def _clean_media_url(value: str, page_url: str) -> str:
    """Converte uma URL embutida em HTML para uma URL absoluta utilizável."""
    value = _html.unescape(value).replace("\\/", "/").strip().strip("'\"")
    if value.startswith("//"):
        value = f"{urlparse(page_url).scheme}:{value}"
    return urljoin(page_url, value)


def _find_embedded_iframes(page_url: str) -> list[str]:
    """Retorna URLs de players incorporados encontrados na página."""
    req = Request(page_url, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
    })
    with urlopen(req, timeout=20) as response:
        raw = response.read(8 * 1024 * 1024)
        charset = response.headers.get_content_charset() or "utf-8"
    text = raw.decode(charset, errors="replace")
    result = []
    for value in re.findall(r"<iframe[^>]+src=[\"']([^\"']+)", text, re.I):
        iframe_url = _clean_media_url(value, page_url)
        if urlparse(iframe_url).scheme in ("http", "https") and iframe_url not in result:
            result.append(iframe_url)
    return result


def _find_embedded_media(page_url: str, _depth: int = 0) -> tuple[str | None, str | None]:
    """Encontra mídia em HTML de players simples (video/source, OG e JWPlayer).

    Alguns sites de vídeo não têm um IE próprio no yt-dlp, mas deixam a URL
    real no HTML. Este fallback só é usado quando o extrator principal falha.
    """
    req = Request(page_url, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
    })
    with urlopen(req, timeout=20) as response:
        raw = response.read(8 * 1024 * 1024)
        charset = response.headers.get_content_charset() or "utf-8"
    text = raw.decode(charset, errors="replace")

    title_match = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
    title = re.sub(r"\s+", " ", _html.unescape(title_match.group(1))).strip() if title_match else None

    # A ordem privilegia a fonte de vídeo explícita e depois configurações de players.
    patterns = (
        r"<source[^>]+(?:src|file)=[\"']([^\"']+)",
        r"<video[^>]+(?:src|data-src)=[\"']([^\"']+)",
        r"(?:og:video(?::secure_url)?|twitter:player:stream)[\"']?\s*content=[\"']([^\"']+)",
        r"(?:file|src|source|videoUrl|video_url)\s*[:=]\s*[\"']([^\"']+\.(?:m3u8|mp4|webm|mpd)(?:\?[^\"']*)?)",
    )
    candidates = []
    for pattern in patterns:
        candidates.extend((candidate, True) for candidate in re.findall(pattern, text, re.I | re.S))
    if not candidates:
        candidates = [(candidate, False) for candidate in _MEDIA_RE.findall(text)]

    for candidate, explicit in candidates:
        media_url = _clean_media_url(candidate, page_url)
        parsed = urlparse(media_url)
        if parsed.scheme in ("http", "https") and parsed.netloc and (explicit or re.search(
                r"\.(?:m3u8|mp4|webm|mpd)(?:$|[?#])", media_url, re.I)):
            return media_url, title

    # Muitos sites deixam apenas um iframe no HTML e o player está nessa página.
    if _depth == 0:
        iframe_urls = re.findall(r"<iframe[^>]+src=[\"']([^\"']+)", text, re.I)
        for iframe_url in iframe_urls[:3]:
            iframe_url = _clean_media_url(iframe_url, page_url)
            if urlparse(iframe_url).scheme in ("http", "https"):
                try:
                    media_url, iframe_title = _find_embedded_media(iframe_url, 1)
                    if media_url:
                        return media_url, title or iframe_title
                except Exception:
                    continue
    return None, title


def _extract_info_with_fallback(ydl, url: str):
    """Extrai normalmente; se a página não for suportada, tenta sua mídia embutida."""
    try:
        return ydl.extract_info(url, download=False)
    except Exception as original_error:
        media_url, page_title = _find_embedded_media(url)
        if media_url:
            try:
                ydl.params.setdefault("http_headers", {}).update({"Referer": url})
                info = ydl.extract_info(media_url, download=False)
            except Exception:
                # Ainda permite baixar URLs diretas que o yt-dlp não consegue analisar.
                info = {"id": media_url.rsplit("/", 1)[-1], "title": page_title or url,
                        "url": media_url, "formats": [{"format_id": "best", "url": media_url,
                        "ext": "mp4" if ".mp4" in media_url.lower() else "mp4",
                        "vcodec": "unknown", "acodec": "unknown"}]}
            info.setdefault("webpage_url", url)
            if page_title and not info.get("title"):
                info["title"] = page_title
            return info

        # O player pode ser um embed suportado pelo yt-dlp (Vimeo, Doodstream,
        # Streamtape etc.), mesmo quando a página original não é suportada.
        for iframe_url in _find_embedded_iframes(url)[:5]:
            try:
                info = ydl.extract_info(iframe_url, download=False)
                info.setdefault("webpage_url", url)
                return info
            except Exception:
                continue
        raise original_error


# ---- persistência da biblioteca ----
def load_library():
    global LIBRARY
    try:
        with open(LIBRARY_FILE, "r", encoding="utf-8") as f:
            LIBRARY = [d for d in json.load(f) if isinstance(d, str)]
    except (OSError, json.JSONDecodeError):
        LIBRARY = []


def save_library():
    try:
        with open(LIBRARY_FILE, "w", encoding="utf-8") as f:
            json.dump(LIBRARY, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def add_library(folder: str):
    with LIB_LOCK:
        folder = safe_dir(folder)
        if not os.path.isdir(folder):
            return
        if folder in LIBRARY:
            # move para o topo (mais recente)
            LIBRARY.remove(folder)
        LIBRARY.insert(0, folder)
        # limita a 50 entradas
        del LIBRARY[50:]
        save_library()


def load_config():
    global CONFIG
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            CONFIG.update({k: v for k, v in data.items() if isinstance(k, str)})
    except (OSError, json.JSONDecodeError):
        pass


def save_config():
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(CONFIG, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def load_folders_config():
    global FOLDERS_CONFIG
    try:
        if os.path.exists(FOLDERS_CONFIG_FILE):
            with open(FOLDERS_CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                FOLDERS_CONFIG = data
        else:
            FOLDERS_CONFIG = {}
    except Exception:
        FOLDERS_CONFIG = {}


def save_folders_config():
    try:
        with open(FOLDERS_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(FOLDERS_CONFIG, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def ffprobe_duration(path: str) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=15)
        return float(r.stdout.strip() or 0)
    except Exception:
        return 0.0


def generate_thumb(path: str) -> str | None:
    """Gera (com cache) uma miniatura JPG do vídeo e retorna o caminho do arquivo."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    # v2 invalida o cache antigo de 320px e gera uma imagem nítida para o hero.
    key = f"thumb-v2|{path}|{st.st_mtime}|{st.st_size}"
    h = hashlib.md5(key.encode("utf-8")).hexdigest()
    os.makedirs(THUMB_DIR, exist_ok=True)
    out = os.path.join(THUMB_DIR, h + ".jpg")
    if os.path.isfile(out):
        return out
    dur = ffprobe_duration(path)
    seek = max(0.0, min(dur * 0.1, 60.0)) if dur > 0 else 0.0
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if seek > 0:
        cmd += ["-ss", str(seek)]
    cmd += ["-i", path, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "2", out]
    try:
        subprocess.run(cmd, capture_output=True, timeout=60)
    except Exception:
        return None
    if os.path.isfile(out) and os.path.getsize(out) > 0:
        return out
    return None


def ensure_playable(path: str) -> str | None:
    """Garante um mp4 browser-friendly (faststart + AAC mp4) via remux sem perda.

    Stream copy (sem re-encode) => sem perda de qualidade. Aplica o bitstream
    filter aac_adtstoasc para converter AAC ADTS (comum em HLS .ts) para mp4;
    se o filtro falhar (áudio já mp4-style), refaz sem ele.Resultado com cache.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = f"{path}|{st.st_mtime}|{st.st_size}"
    h = hashlib.md5(key.encode("utf-8")).hexdigest()
    os.makedirs(PLAYCACHE_DIR, exist_ok=True)
    out = os.path.join(PLAYCACHE_DIR, h + ".mp4")
    tmp = out + ".tmp.mp4"
    if os.path.isfile(out) and os.path.getsize(out) > 0:
        return out

    # lock por arquivo p/ não remuxar 2x em paralelo
    with _play_locks_guard:
        lock = _play_locks.setdefault(path, threading.Lock())
    with lock:
        if os.path.isfile(out) and os.path.getsize(out) > 0:
            return out
        # tenta com aac_adtstoasc (HLS/TS) e cai sem bsf se falhar
        for bsf in (["-bsf:a", "aac_adtstoasc"], []):
            if os.path.isfile(tmp):
                try: os.remove(tmp)
                except OSError: pass
            cmd = ["ffmpeg", "-y", "-v", "error", "-i", path,
                   "-c", "copy", *bsf, "-movflags", "+faststart", tmp]
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=900)
            except Exception:
                continue
            if r.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                os.replace(tmp, out)
                return out
        # fallback: serve o arquivo original (pode já ser compatível)
        return path


# --------------------------------------------------------------------------- #
# Rotas — páginas e API
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/browse", methods=["GET"])
def api_browse():
    path = request.args.get("path", HOME)
    path = safe_dir(path)
    if not os.path.isdir(path):
        path = HOME
    dirs, resolved = list_dirs(path)
    parent = os.path.dirname(resolved) if resolved != "/" else "/"
    return jsonify({
        "path": resolved,
        "parent": parent,
        "home": HOME,
        "dirs": dirs,
        "mounts": get_mounts(),
    })


@app.route("/api/mkdir", methods=["POST"])
def api_mkdir():
    """Cria uma nova pasta dentro de um diretório pai."""
    data = request.get_json(silent=True) or {}
    parent = safe_dir(data.get("parent") or HOME)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Nome ausente."}), 400
    if not os.path.isdir(parent):
        return jsonify({"error": "Pasta pai inválida."}), 400
    # sanitiza: sem barras, sem ".."
    name = name.replace("/", "_").replace("\\", "_").strip()
    if name in (".", "..") or name.startswith("."):
        return jsonify({"error": "Nome inválido."}), 400
    full = os.path.join(parent, name)
    try:
        os.makedirs(full, exist_ok=True)
    except OSError as e:
        return jsonify({"error": f"Não foi possível criar: {e}"}), 500
    return jsonify({"ok": True, "path": full})


@app.route("/api/config", methods=["GET"])
def api_config_get():
    with CONFIG_LOCK:
        return jsonify(dict(CONFIG))


@app.route("/api/config", methods=["PUT"])
def api_config_put():
    data = request.get_json(silent=True) or {}
    with CONFIG_LOCK:
        for k, v in data.items():
            if k in ("default_out_dir",) and isinstance(v, str):
                CONFIG[k] = safe_dir(v) or HOME
        save_config()
    return jsonify({"ok": True, "config": dict(CONFIG)})


@app.route("/api/scan", methods=["GET"])
def api_scan():
    """Lista arquivos de vídeo de uma pasta."""
    path = safe_dir(request.args.get("path", HOME))
    if not os.path.isdir(path):
        return jsonify({"error": "Pasta não encontrada."}), 404

    with FOLDERS_CONFIG_LOCK:
        folder_cfg = FOLDERS_CONFIG.get(path, {})
        if folder_cfg.get("private", False) and (path not in UNLOCKED_FOLDERS):
            return jsonify({"error": "Esta pasta está protegida por senha.", "locked": True}), 403

    videos, resolved = list_videos(path)
    return jsonify({"path": resolved, "videos": videos})


@app.route("/api/thumb", methods=["GET"])
def api_thumb():
    """Gera/serve miniatura de um vídeo (com cache em .thumbs)."""
    path = os.path.abspath(os.path.expanduser(request.args.get("path", "")))
    if not path or not os.path.isfile(path):
        return jsonify({"error": "Arquivo não encontrado."}), 404
    thumb = generate_thumb(path)
    if not thumb:
        # fallback 1x1 para não quebrar o <img>
        return send_from_directory(os.path.join(BASE, "static"), "nothumb.png")
    return send_from_directory(THUMB_DIR, os.path.basename(thumb), mimetype="image/jpeg",
                               conditional=True)


@app.route("/api/library", methods=["GET"])
def api_library():
    with LIB_LOCK:
        folders = [d for d in LIBRARY if os.path.isdir(d)]
    
    with FOLDERS_CONFIG_LOCK:
        load_folders_config()
        result = []
        for d in folders:
            folder_cfg = FOLDERS_CONFIG.get(d, {})
            is_private = folder_cfg.get("private", False)
            is_locked = is_private and (d not in UNLOCKED_FOLDERS)
            
            count = 0
            if not is_locked:
                vids, _ = list_videos(d)
                count = len(vids)
                
            result.append({
                "path": d,
                "count": count,
                "private": is_private,
                "locked": is_locked
            })
    return jsonify(result)


@app.route("/api/library", methods=["DELETE"])
def api_library_remove():
    data = request.get_json(silent=True) or {}
    folder = safe_dir(data.get("path") or "")
    with LIB_LOCK:
        if folder in LIBRARY:
            LIBRARY.remove(folder)
            save_library()
    with FOLDERS_CONFIG_LOCK:
        if folder in FOLDERS_CONFIG:
            FOLDERS_CONFIG.pop(folder, None)
            save_folders_config()
        if folder in UNLOCKED_FOLDERS:
            UNLOCKED_FOLDERS.remove(folder)
    return jsonify({"ok": True})


@app.route("/api/history", methods=["DELETE"])
def api_history_clear():
    """Limpa todo o histórico da biblioteca (não apaga arquivos do disco)."""
    with LIB_LOCK:
        LIBRARY.clear()
        save_library()
    with FOLDERS_CONFIG_LOCK:
        FOLDERS_CONFIG.clear()
        save_folders_config()
        UNLOCKED_FOLDERS.clear()
    return jsonify({"ok": True})


@app.route("/api/folder/unlock", methods=["POST"])
def api_folder_unlock():
    data = request.get_json(silent=True) or {}
    path = safe_dir(data.get("path") or "")
    password = data.get("password") or ""
    
    with FOLDERS_CONFIG_LOCK:
        folder_cfg = FOLDERS_CONFIG.get(path, {})
        if not folder_cfg.get("private", False):
            return jsonify({"ok": True})
        if folder_cfg.get("password") == password:
            UNLOCKED_FOLDERS.add(path)
            return jsonify({"ok": True})
        return jsonify({"error": "Senha incorreta."}), 401


@app.route("/api/folder/lock", methods=["POST"])
def api_folder_lock():
    data = request.get_json(silent=True) or {}
    path = safe_dir(data.get("path") or "")
    if path in UNLOCKED_FOLDERS:
        UNLOCKED_FOLDERS.remove(path)
    return jsonify({"ok": True})


@app.route("/api/folder/privacy", methods=["POST"])
def api_folder_privacy():
    data = request.get_json(silent=True) or {}
    path = safe_dir(data.get("path") or "")
    private = bool(data.get("private", False))
    password = data.get("password") or ""
    current_password = data.get("current_password") or ""
    
    with FOLDERS_CONFIG_LOCK:
        load_folders_config()
        folder_cfg = FOLDERS_CONFIG.setdefault(path, {})
        
        # Se já era privada, exige senha atual para alterar/remover
        if folder_cfg.get("private", False):
            if folder_cfg.get("password") != current_password:
                return jsonify({"error": "Senha atual incorreta."}), 401
                
        if private:
            if not password:
                return jsonify({"error": "A senha é obrigatória para pastas privadas."}), 400
            folder_cfg["private"] = True
            folder_cfg["password"] = password
            UNLOCKED_FOLDERS.add(path) # desbloqueia imediatamente ao configurar
        else:
            folder_cfg["private"] = False
            folder_cfg.pop("password", None)
            if path in UNLOCKED_FOLDERS:
                UNLOCKED_FOLDERS.remove(path)
                
        save_folders_config()
    return jsonify({"ok": True})


@app.route("/api/file", methods=["DELETE"])
def api_file_delete():
    """Apaga um arquivo de vídeo do disco."""
    path = os.path.abspath(os.path.expanduser((request.get_json(silent=True) or {}).get("path", "")))
    if not path or not os.path.isfile(path):
        return jsonify({"error": "Arquivo não encontrado."}), 404
    ext = os.path.splitext(path)[1].lower()
    if ext not in VIDEO_EXTS:
        return jsonify({"error": "Só é permitido excluir arquivos de vídeo."}), 400
    try:
        os.remove(path)
    except OSError as e:
        return jsonify({"error": f"Não foi possível excluir: {e}"}), 500
    return jsonify({"ok": True})


@app.route("/api/file", methods=["GET"])
def api_file():
    """Serve um arquivo de vídeo com suporte a Range (seek no <video>)."""
    path = request.args.get("path", "")
    path = os.path.abspath(os.path.expanduser(path))
    if not path or not os.path.isfile(path):
        return jsonify({"error": "Arquivo não encontrado."}), 404
    ext = os.path.splitext(path)[1].lower()
    mime = {
        ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm",
        ".ts": "video/mp2t", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
        ".m4v": "video/x-m4v", ".ogv": "video/ogg", ".flv": "video/x-flv",
        ".wmv": "video/x-ms-wmv", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
        ".3gp": "video/3gpp",
    }.get(ext, "application/octet-stream")
    # send_file do Flask/Werkzeug responde 206 Partial Content (Range) automaticamente.
    return send_from_directory(os.path.dirname(path), os.path.basename(path),
                                mimetype=mime, conditional=True)


@app.route("/api/play", methods=["GET"])
def api_play():
    """Serve o vídeo num formato compatível com navegador (remux sem perda + cache).

    Garante áudio AAC mp4 (corrige ADTS do HLS) e faststart para seek funcionar.
    """
    path = os.path.abspath(os.path.expanduser(request.args.get("path", "")))
    if not path or not os.path.isfile(path):
        return jsonify({"error": "Arquivo não encontrado."}), 404
    playable = ensure_playable(path)
    if not playable or not os.path.isfile(playable):
        return jsonify({"error": "Não foi possível preparar o vídeo."}), 500
    return send_from_directory(os.path.dirname(playable), os.path.basename(playable),
                               mimetype="video/mp4", conditional=True)


@app.route("/api/info", methods=["POST"])
def api_info():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "URL ausente."}), 400
    if yt_dlp is None:
        return jsonify({"error": "yt-dlp não instalado. Rode install.sh."}), 500

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "extract_flat": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = _extract_info_with_fallback(ydl, url)
    except Exception as e:
        return jsonify({"error": f"Falha ao analisar: {e}"}), 500

    # Pode vir playlist (mesmo com noplaylist em alguns casos) — pega só 1º.
    if "entries" in info and isinstance(info["entries"], list):
        entries = [e for e in info["entries"] if e]
        if not entries:
            return jsonify({"error": "Nenhum item encontrado."}), 404
        info = entries[0]

    formats = []
    for f in (info.get("formats") or []):
        vcodec = f.get("vcodec")
        acodec = f.get("acodec")
        has_video = bool(vcodec) and vcodec != "none"
        has_audio = bool(acodec) and acodec != "none"
        height = f.get("height")
        ext = f.get("ext")
        filesize = f.get("filesize") or f.get("filesize_approx")
        formats.append({
            "format_id": f.get("format_id"),
            "ext": ext,
            "resolution": f"{height}p" if height else (f.get("format_note") or ext or "?"),
            "height": height,
            "fps": f.get("fps"),
            "vcodec": vcodec,
            "acodec": acodec,
            "filesize": filesize,
            "tbr": f.get("tbr"),
            "has_video": has_video,
            "has_audio": has_audio,
            "video_only": has_video and acodec == "none",
        })

    # Se não vier formato combinado, adiciona "best" virtual.
    return jsonify({
        "title": info.get("title") or info.get("id") or url,
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "uploader": info.get("uploader"),
        "formats": formats,
        "url": url,
        "ext": info.get("ext"),
    })


def run_download(job_id: str, url: str, format_id: str, out_dir: str):
    job = JOBS[job_id]
    q: "_queue.Queue" = job["queue"]

    def hook(d):
        if job["cancelled"]:
            raise yt_dlp.utils.DownloadCancelled("Cancelado pelo usuário") \
                if hasattr(yt_dlp, "utils") and hasattr(yt_dlp.utils, "DownloadCancelled") \
                else Exception("Cancelado")
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            downloaded = d.get("downloaded_bytes") or 0
            pct = (downloaded / total * 100) if total else None
            job["progress"] = pct
            job["status"] = "downloading"
            job["filename"] = d.get("filename")
            q.put({
                "status": "downloading",
                "percent": round(pct, 1) if pct is not None else None,
                "speed": d.get("speed"),
                "eta": d.get("eta"),
                "downloaded": downloaded,
                "total": total,
            })
        elif status == "finished":
            job["status"] = "merging"
            job["filename"] = d.get("filename")
            q.put({"status": "merging", "filename": d.get("filename")})

    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:
        job["status"] = "error"
        job["error"] = f"Pasta inválida: {e}"
        q.put({"status": "error", "error": job["error"]})
        q.put(None)
        return

    # Seletor de formato: "best" => melhor vídeo + melhor áudio (merge).
    # Para formatos só-vídeo, o front já envia "id+bestaudio/best" => áudio garantido.
    fmt = format_id or "b*+ba/b"
    opts = {
        # O ID do job impede que um novo download sobrescreva outro arquivo
        # com o mesmo título (inclusive quando a mesma URL é baixada novamente).
        "outtmpl": os.path.join(out_dir, f"%(title).80s [{job_id}].%(ext)s"),
        "format": fmt,
        "merge_output_format": "mp4",
        # stream copy + faststart => sem perda de qualidade e compatível com navegador
        "postprocessor_args": ["-c", "copy", "-movflags", "+faststart"],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            try:
                ydl.download([url])
            except Exception as original_error:
                # Páginas sem extrator dedicado podem apontar para um arquivo
                # ou playlist HLS no HTML. Tenta a mídia descoberta no fallback.
                media_url, _ = _find_embedded_media(url)
                ydl.params.setdefault("http_headers", {}).update({"Referer": url})
                if media_url:
                    ydl.download([media_url])
                else:
                    iframe_error = original_error
                    for iframe_url in _find_embedded_iframes(url)[:5]:
                        try:
                            ydl.download([iframe_url])
                            break
                        except Exception as error:
                            iframe_error = error
                    else:
                        raise iframe_error
        # O nome recebido no hook pode ser temporário quando houve merge.
        # Seleciona o arquivo de vídeo mais recente caso isso aconteça.
        if not job.get("filename") or not os.path.isfile(job["filename"]):
            downloaded, _ = list_videos(out_dir)
            if downloaded:
                job["filename"] = downloaded[0]["path"]
        job["status"] = "done"
        add_library(out_dir)
        q.put({"status": "done", "filename": job.get("filename"), "out_dir": out_dir})
    except Exception as e:
        if job["cancelled"]:
            job["status"] = "cancelled"
            q.put({"status": "cancelled"})
        else:
            job["status"] = "error"
            job["error"] = str(e)
            q.put({"status": "error", "error": str(e)})
    finally:
        q.put(None)  # sinal de fim do stream


@app.route("/api/download", methods=["POST"])
def api_download():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    format_id = (data.get("format_id") or "").strip() or "best"
    out_dir = safe_dir(data.get("out_dir") or HOME)
    if not url:
        return jsonify({"error": "URL ausente."}), 400
    if yt_dlp is None:
        return jsonify({"error": "yt-dlp não instalado. Rode install.sh."}), 500
    if not os.path.isdir(out_dir):
        try:
            os.makedirs(out_dir, exist_ok=True)
        except Exception as e:
            return jsonify({"error": f"Pasta inválida: {e}"}), 400

    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "url": url,
        "out_dir": out_dir,
        "format_id": format_id,
        "status": "queued",
        "progress": None,
        "filename": None,
        "error": None,
        "cancelled": False,
        "queue": _queue.Queue(),
        "created": time.time(),
    }
    with JOBS_LOCK:
        JOBS[job_id] = job

    t = threading.Thread(target=run_download, args=(job_id, url, format_id, out_dir), daemon=True)
    job["thread"] = t
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/api/progress/<job_id>")
def api_progress(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job não encontrado."}), 404
    q: "_queue.Queue" = job["queue"]

    def stream():
        # Evento inicial com estado atual
        yield f"data: {json.dumps({'status': job['status'], 'percent': job.get('progress')})}\n\n"
        while True:
            try:
                msg = q.get(timeout=15)
            except _queue.Empty:
                yield ": keepalive\n\n"
                continue
            if msg is None:
                break
            yield f"data: {json.dumps(msg)}\n\n"
        # estado final
        final = {"status": job["status"], "percent": job.get("progress"),
                 "filename": job.get("filename"), "error": job.get("error")}
        yield f"data: {json.dumps({'_final': True, **final})}\n\n"

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/cancel/<job_id>", methods=["POST"])
def api_cancel(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job não encontrado."}), 404
    job["cancelled"] = True
    job["status"] = "cancelling"
    job["queue"].put({"status": "cancelling"})
    return jsonify({"ok": True})


@app.route("/api/jobs")
def api_jobs():
    with JOBS_LOCK:
        return jsonify([{
            "id": j["id"], "url": j["url"], "out_dir": j["out_dir"],
            "status": j["status"], "progress": j.get("progress"),
            "filename": j.get("filename"), "error": j.get("error"),
        } for j in JOBS.values()])


if __name__ == "__main__":
    load_library()
    load_config()
    load_folders_config()
    print(f"\n  Baixador de Vídeos Universal")
    print(f"  → http://{HOST}:{PORT}\n")
    app.run(host=HOST, port=PORT, threaded=True, debug=False)
