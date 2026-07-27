# Simply Downloads — Filmes, Séries e Downloads Ilimitados

Um aplicativo web local (localhost) elegante com cara de serviço de streaming para baixar vídeos de qualquer link suportado pelo [yt-dlp](https://github.com/yt-dlp/yt-dlp) — incluindo transmissões ao vivo, streams **HLS `.m3u8`**, YouTube, e milhares de outras plataformas.

---

## 🚀 Recursos
- **Interface Estilo Stream**: Visual dark premium unindo a estética da Netflix e HBO Max (Max) com transições fluidas e desfoques de fundo.
- **Player de Cinema Integrado**: Abre automaticamente em tela cheia na janela (100% da viewport), com botão para voltar, passar para o próximo vídeo da pasta (Autoplay) e atalhos de teclado.
- **Modo Cinema / Compacto**: Alterne a visualização do player na janela do navegador a qualquer momento.
- **Navegador de Pastas Server-side**: Escolha e gerencie pastas físicas de destino direto pelo navegador, organizadas em uma grade limpa.
- **Pastas Privadas**: Defina pastas protegidas por senha (criptografada localmente) para ocultar e trancar arquivos.
- **Fila de Downloads**: Adicione múltiplos links em segundo plano e acompanhe a velocidade e ETA por eventos em tempo real (SSE).

---

## 🛠️ Requisitos Gerais
Para executar a ferramenta, você precisará de:
1. **Python 3** (e gerenciador de pacotes `pip`).
2. **FFmpeg** e **FFprobe** (ferramentas de mídia necessárias para muxar/mesclar vídeo e áudio baixados e gerar miniaturas).

---

## 💻 Guia de Instalação por Sistema Operacional

Escolha a seção correspondente ao seu sistema operacional:

### 1. Windows

No Windows, a forma mais fácil de instalar as dependências é usando o Prompt de Comando (CMD) ou PowerShell.

#### Passo 1: Instalar o Python
1. Baixe o instalador do Python 3 para Windows no site oficial: [python.org/downloads](https://www.python.org/downloads/).
2. Ao executar o instalador, **marque obrigatoriamente** a caixa **"Add python.exe to PATH"** antes de clicar em instalar.

#### Passo 2: Instalar o FFmpeg
Abra o **PowerShell** como Administrador e execute o gerenciador de pacotes padrão do Windows (Winget):
```powershell
winget install Gyan.FFmpeg
```
*Caso prefira usar o **Chocolatey**, execute:*
```powershell
choco install ffmpeg
```
*Se preferir instalar manualmente, baixe os executáveis do site do FFmpeg, extraia a pasta e adicione o caminho do diretório `bin/` nas Variáveis de Ambiente do Windows.*

#### Passo 3: Configurar e Rodar o App
Abra o terminal na pasta do projeto e execute:
```cmd
pip install -r requirements.txt
python app.py
```

---

### 2. Linux

Selecione a sua distribuição Linux para instalar os pacotes necessários:

#### Debian / Ubuntu e derivados (Mint, Pop!_OS, etc.)
```bash
sudo apt update
sudo apt install -y python3 python3-pip ffmpeg
```

#### Fedora / RHEL
```bash
sudo dnf install -y python3 python3-pip ffmpeg
```

#### Arch Linux / Manjaro
```bash
sudo pacman -S --noconfirm python python-pip ffmpeg
```

#### Passo Final: Instalar dependências e rodar
Entre no diretório do projeto e execute:
```bash
pip install -r requirements.txt
python3 app.py
```

---

### 3. macOS

No macOS, recomendamos o uso do gerenciador de pacotes **Homebrew**.

#### Passo 1: Instalar o Homebrew (se já não possuir)
Abra o terminal e cole o comando:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

#### Passo 2: Instalar dependências
```bash
brew install python ffmpeg
```

#### Passo 3: Configurar e rodar o App
Abra o terminal na pasta do projeto e execute:
```bash
pip3 install -r requirements.txt
python3 app.py
```

---

## 🏃 Como Rodar o Servidor
Com tudo instalado, basta executar na pasta raiz:
```bash
python3 app.py
```
*(No Windows, utilize `python app.py`)*

Abra o seu navegador e acesse: **[http://127.0.0.1:5000](http://127.0.0.1:5000)**

---

## ⌨️ Atalhos do Teclado no Player
Quando o player estiver aberto, você pode controlá-lo de forma rápida pelo teclado:
- **Espaço**: Reproduzir / Pausar.
- **Seta para a Esquerda**: Retroceder 10 segundos.
- **Seta para a Direita**: Avançar 10 segundos.
- **Seta para Cima**: Aumentar volume.
- **Seta para Baixo**: Diminuir volume.
- **Tecla F**: Alternar tela cheia nativa.
- **Esc**: Fechar o player ou modais ativos.