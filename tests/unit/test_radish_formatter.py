from __future__ import annotations

from pathlib import Path

import pytest

from gofer.radish.diagnostics import RadishParseError
from gofer.radish.formatter import format_radish, format_radish_file
from gofer.radish.parser import parse_radish

MESSY_SOURCE = """# file comment
RADISH : 1 # version comment

WORKFLOW : # workflow comment
\tNAME : "Case # preserved" # name comment

# declaration comment
NODE Build :
\tTYPE : BASH-COMMAND
\tCOMMAND : |
\t\techo "# block content"
\tTO :
\t\t- Done WHEN NODE.Build.OUTPUT["Result"] == "OK" # route comment
NODE Done:
  TYPE: BASH-COMMAND
  COMMAND: echo done
  FINISH: PASS
"""


CANONICAL_SOURCE = """# file comment
radish: 1  # version comment

workflow:  # workflow comment
  name: "Case # preserved"  # name comment

# declaration comment
node build:
  type: bash-command
  command: |
    echo "# block content"
  to:
    - done when node.build.output["Result"] == "OK"  # route comment

node done:
  type: bash-command
  command: echo done
  finish: pass
"""


def test_formatter_canonicalizes_layout_and_radish_identifiers_without_changing_data() -> None:
    formatted = format_radish(MESSY_SOURCE)

    assert formatted == CANONICAL_SOURCE
    assert parse_radish(formatted)["nodes"][0]["name"]["canonical"] == "build"


def test_formatter_is_idempotent_and_always_emits_one_final_newline() -> None:
    first = format_radish(MESSY_SOURCE.rstrip())
    second = format_radish(first)

    assert second == first
    assert first.endswith("\n")
    assert not first.endswith("\n\n")


def test_format_file_check_mode_does_not_write(tmp_path: Path) -> None:
    source = tmp_path / "workflow.rad"
    source.write_text(MESSY_SOURCE, encoding="utf-8")

    checked = format_radish_file(source, write=False)
    written = format_radish_file(source)

    assert checked.changed is True
    assert source.read_text(encoding="utf-8") == CANONICAL_SOURCE
    assert written.changed is True
    assert format_radish_file(source, write=False).changed is False


def test_formatter_rejects_invalid_source_without_partial_output() -> None:
    with pytest.raises(RadishParseError):
        format_radish("Radish: 1\nWorkflow:\n  name:\n")


def test_formatter_canonicalizes_public_output_references_without_changing_json_case() -> None:
    source = """RADISH: 1
WORKFLOW:
  NAME: Output formatting
  OUTPUTS:
    Result:
      FROM: NODE.Build.OUTPUT["DisplayName"]
      SCHEMA: {"properties":{"DisplayName":{"type":"string"}},"type":"object"}
NODE Build:
  TYPE: BASH-COMMAND
  COMMAND: echo ready
"""

    formatted = format_radish(source)

    assert "result:" in formatted
    assert 'from: node.build.output["DisplayName"]' in formatted
    assert '"DisplayName"' in formatted
    assert format_radish(formatted) == formatted


def test_formatter_preserves_with_expressions() -> None:
    source = """Radish: 1
Workflow:
  name: Expression formatting
Node review:
  type: approval-gate
  message: Continue?
  with:
    all-good: NODE.Score.OUTPUT.coverage > 80
"""

    formatted = format_radish(source)

    assert "all-good: node.score.output.coverage > 80" in formatted
    assert format_radish(formatted) == formatted
