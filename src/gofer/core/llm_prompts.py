from __future__ import annotations


def common_llm_task_prompt(task: str, target: str, instructions: str = "") -> str:
    task_prompts = {
        "review": "Review the provided content. Identify issues, risks, and concrete improvements.",
        "summarize": "Summarize the provided content clearly and concisely.",
        "explain": "Explain the provided content in practical terms for the intended user.",
        "extract": "Extract the requested facts, entities, decisions, or action items.",
        "rewrite": "Rewrite the provided content according to the user's instructions.",
        "classify": "Classify the provided content and explain the classification briefly.",
    }
    parts = [task_prompts.get(task, task_prompts["summarize"])]
    if instructions.strip():
        parts += ["", "Additional instructions:", instructions.strip()]
    if target.strip():
        parts += ["", "Target content or path:", target.strip()]
    parts += [
        "",
        "Context from workflow inputs, mapped variables, or piped predecessor output may follow.",
    ]
    return "\n".join(parts)
