# Project

<!-- Describe what this project does in 1-2 sentences -->

## Commands

```bash
uv sync                    # Install dependencies
uv run python <script>     # Run a script
uv run pytest              # Run tests
uv add <package>           # Add a dependency
```

## Architecture

<!-- Describe the high-level structure of your project.
     Example:
     - my_project/core/     — domain logic
     - my_project/data/     — data loading and processing
     - notebooks/           — exploratory analysis
     - context/             — design docs and requirements
-->

## Conventions

- Python >=3.10, use modern syntax (type hints, match statements, etc.)
- Use uv for dependency management (never pip)
- Keep modules focused — one responsibility per file
- Tests go in a `tests/` directory, mirroring the package structure

## Context

- Design docs and requirements live in `context/`
- Read `context/DESIGN-DOC.md` before making architectural decisions
