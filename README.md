# Python Vibe Template

A project template for vibe coding with **Claude Code** + **VS Code devcontainers** + **uv**.

## Quick Start

1. Click **"Use this template"** > **"Create a new repository"** on GitHub
2. In VS Code, run **"Dev Containers: Clone Repository in Container Volume..."** and paste your new repo URL
3. The container builds, `uv sync` runs automatically — you're ready to go

## First Steps

1. Rename `my_project/` to your package name
2. Update `name` and `packages` in `pyproject.toml` to match
3. Fill in `CLAUDE.md` with your project description and conventions
4. Write your idea in `context/DESIGN-DOC.md`
5. Start talking to Claude Code

## What's Included

| File | Purpose |
|------|---------|
| `.devcontainer/` | Python 3.14, uv, GitHub CLI, VS Code extensions |
| `pyproject.toml` | hatchling build system, dev deps (pytest, jupyter) |
| `CLAUDE.md` | Claude Code reads this at conversation start |
| `context/DESIGN-DOC.md` | Place for requirements and design docs |
| `my_project/` | Skeleton Python package |
| `notebooks/` | Jupyter notebooks |

## Adding Dependencies

```bash
uv add pandas              # Add a runtime dependency
uv add --dev ruff          # Add a dev dependency
uv run pytest              # Run tests
uv run python script.py    # Run a script
```
