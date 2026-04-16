#!/usr/bin/env bash
# Runs once when the devcontainer / Codespace is first created.
set -euo pipefail

echo "==> Installing Python dependencies with uv"
uv sync

echo "==> Materializing the Pyodide copy of my_project/ for the browser game"
# frontend/data/game/my_project/ is gitignored — generated here so Live
# Server can serve a working multiplayer.html out of the box. Devs must
# re-run this after any edit to my_project/ that they want to see in the
# browser (the CI deploy workflow regenerates it automatically).
uv run python -m my_project.cli sync-play

echo "==> Configuring gh CLI git helper"
gh auth setup-git || true

# The devcontainer's Node feature adds a yarn apt source whose upstream GPG key
# periodically rotates and breaks `apt-get update`. Yarn isn't used by this
# project, and a broken apt source blocks `playwright install --with-deps`.
echo "==> Removing stale yarn apt source (if present) to unblock apt-get"
sudo rm -f /etc/apt/sources.list.d/yarn.list || true

echo "==> Installing Playwright Chromium + system dependencies"
# --with-deps uses sudo apt-get (passwordless in Codespaces) to install the
# shared libraries (libnss3, libatk-bridge, libdrm, libgbm, etc.) that Chromium
# needs. Falls back to browser-only install if --with-deps fails.
npx -y playwright install --with-deps chromium || npx -y playwright install chromium

echo "==> Linking Chromium into /opt/google/chrome/chrome for the Playwright MCP server"
# The Playwright MCP server (.mcp.json) defaults to looking for Chrome at
# /opt/google/chrome/chrome and its --browser flag doesn't accept "chromium"
# (only chrome/firefox/webkit/msedge). Point that path at the Chromium binary
# we just installed so the MCP launches cleanly without requiring a separate
# Google Chrome install.
CHROMIUM_BIN="$(find "$HOME/.cache/ms-playwright" -type f -name chrome -path '*chrome-linux64*' 2>/dev/null | head -n 1)"
if [ -n "$CHROMIUM_BIN" ]; then
  sudo mkdir -p /opt/google/chrome || true
  sudo ln -sf "$CHROMIUM_BIN" /opt/google/chrome/chrome || true
  echo "    -> /opt/google/chrome/chrome -> $CHROMIUM_BIN"
else
  echo "    Warning: Chromium binary not found; Playwright MCP may not launch."
fi

echo "==> Dev environment ready"
echo "   - Run tests:      uv run pytest"
echo "   - Serve frontend: (VS Code) right-click frontend/multiplayer.html → Open with Live Server"
echo "   - Claude Code:    sign in via the Claude Code panel in the sidebar"
