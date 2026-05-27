---
name: notebooklm
description: Complete API for Google NotebookLM - full programmatic access including features not in the web UI. Create notebooks, add sources, generate all artifact types, download in multiple formats. Activates on explicit /notebooklm or intent like "create a podcast about X", "install notebooklm", "add notebooklm to cowork"
---

<!-- notebooklm-py v0.3.4 -->

# NotebookLM Automation

Complete programmatic access to Google NotebookLM—including capabilities not exposed in the web UI. Create notebooks, add sources (URLs, YouTube, PDFs, audio, video, images), chat with content, generate all artifact types, and download results in multiple formats.

This skill has **two setup paths**:

1. **Local Claude Code** — Install the `notebooklm-py` CLI on your Mac and authenticate. Fast, direct, no network overhead. Use this for terminal sessions.
2. **Cowork** — Wrap the CLI in an MCP server, tunnel it via Cloudflare, and connect Cowork to the public HTTPS endpoint. Use this when you want NotebookLM access inside Cowork (Anthropic's sandbox can't run your local CLI directly).

The original cookie-inlining approach for Cowork has been **replaced** with the MCP pattern below. It's more robust (no token expiry pain), secure (credentials never leave your Mac), and works for any local CLI you want to expose to Cowork.

---

## Step 0: Local Setup (Run Automatically on First Use)

When this skill is triggered and `notebooklm` is not yet installed or authenticated, complete setup first.

### Pre-flight: Check Python Version

`notebooklm-py` requires **Python 3.10+**. Check the available version before installing:

```bash
python3 --version
```

If Python is below 3.10 (e.g. 3.9.x which is the macOS default), install a compatible version:

**macOS (Homebrew):**

```bash
brew install python@3.12
```

Then use `/opt/homebrew/bin/python3.12` (Apple Silicon) or `/usr/local/bin/python3.12` (Intel) for the venv below.

**Linux (apt):**

```bash
sudo apt update && sudo apt install -y python3.12 python3.12-venv
```

### Install the CLI

Always use a virtual environment to avoid "externally-managed-environment" errors and PATH issues.

Determine which Python to use — if the system `python3` is 3.10+, use it directly. Otherwise use the one you just installed (e.g. `python3.12`):

```bash
# Set PYTHON to the correct binary (adjust if needed)
PYTHON=$(command -v python3.12 2>/dev/null || command -v python3.11 2>/dev/null || command -v python3.10 2>/dev/null || command -v python3)

# Verify it's 3.10+
$PYTHON -c "import sys; assert sys.version_info >= (3,10), f'Python {sys.version} is too old — need 3.10+'; print(f'Using Python {sys.version}')"

# Create venv and install
$PYTHON -m venv ~/.notebooklm-venv
source ~/.notebooklm-venv/bin/activate
pip install "notebooklm-py[browser]"
playwright install chromium
```

Then symlink so it's always on PATH:

```bash
mkdir -p ~/bin
ln -sf ~/.notebooklm-venv/bin/notebooklm ~/bin/notebooklm
export PATH="$HOME/bin:$PATH"
```

Verify the CLI works:

```bash
notebooklm --help
```

### Authenticate

**IMPORTANT:** The built-in `notebooklm login` command requires interactive terminal input (pressing Enter after sign-in). Claude Code's bash tool does NOT support interactive input, so `notebooklm login` will fail — the browser opens and closes instantly. Instead, use this custom login script.

Tell the user:

> I'm going to open a browser window — just sign into your Google account and navigate to notebooklm.google.com. Take your time, I'll wait for you to confirm before closing it.

Then write and run this login script:

```bash
cat > /tmp/nlm_login.py << 'PYEOF'
import json, os, time
from pathlib import Path
from playwright.sync_api import sync_playwright

STORAGE_PATH = Path.home() / ".notebooklm" / "storage_state.json"
PROFILE_PATH = Path.home() / ".notebooklm" / "browser_profile"
SIGNAL_FILE = Path("/tmp/nlm_save_signal")

SIGNAL_FILE.unlink(missing_ok=True)
STORAGE_PATH.parent.mkdir(parents=True, exist_ok
```
