#!/usr/bin/env bash
# Runs once when the devcontainer / Codespace is first created.
set -euo pipefail

echo "==> Installing Python dependencies with uv"
uv sync

echo "==> Configuring gh CLI git helper"
gh auth setup-git || true

echo "==> Pre-installing Playwright Chromium for the Playwright MCP server"
# Install the browser + system libraries. --with-deps uses sudo (passwordless in Codespaces).
# If this fails (e.g., sudo unavailable), the browser still installs on first MCP use.
npx -y playwright install --with-deps chromium || npx -y playwright install chromium

echo "==> Dev environment ready"
echo "   - Run tests:      uv run pytest"
echo "   - Serve frontend: (VS Code) right-click frontend/multiplayer.html → Open with Live Server"
echo "   - Claude Code:    sign in via the Claude Code panel in the sidebar"
