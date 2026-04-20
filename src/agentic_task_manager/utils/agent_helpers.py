from __future__ import annotations

import re
from pathlib import Path


def unique_agent_id(name: str, data_dir: Path) -> str:
    """Slugify name and append a numeric suffix if the ID is already taken."""
    base_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    candidate = base_id
    counter = 2
    while (data_dir / f"{candidate}.toml").exists():
        candidate = f"{base_id}-{counter}"
        counter += 1
    return candidate


def resolve_prompt(prompt: str, data_dir: Path, agent_id: str) -> Path:
    """Return a path to the prompt file, writing inline text if needed."""
    candidate = Path(prompt).expanduser()
    if candidate.exists() and candidate.is_file():
        return candidate.resolve()

    prompts_dir = data_dir / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = prompts_dir / f"{agent_id}.md"
    prompt_file.write_text(prompt)
    return prompt_file
