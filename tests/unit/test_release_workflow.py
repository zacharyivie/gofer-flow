from __future__ import annotations

import re
from pathlib import Path
from typing import Any, cast

REPO_ROOT = Path(__file__).resolve().parents[2]


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    if value == "":
        return ""
    if value in {"true", "false"}:
        return value == "true"
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    return value


def _next_meaningful_line(lines: list[str], start: int) -> str | None:
    for line in lines[start:]:
        if line.strip() and not line.lstrip().startswith("#"):
            return line
    return None


def _parse_workflow_yaml(path: Path) -> dict[str, Any]:
    lines = path.read_text(encoding="utf8").splitlines()
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any] | list[Any]]] = [(-1, root)]
    index = 0

    while index < len(lines):
        raw_line = lines[index]
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            index += 1
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        while stack and indent <= stack[-1][0]:
            stack.pop()
        container = stack[-1][1]

        if stripped.startswith("- "):
            assert isinstance(container, list)
            item_text = stripped[2:]
            if ": " in item_text or item_text.endswith(":"):
                key, separator, value = item_text.partition(":")
                item: dict[str, Any] = {}
                container.append(item)
                if separator and value.strip():
                    item[key] = _parse_scalar(value)
                else:
                    next_line = _next_meaningful_line(lines, index + 1)
                    child: dict[str, Any] | list[Any]
                    child = [] if next_line and next_line.strip().startswith("- ") else {}
                    item[key] = child
                    stack.append((indent + 2, item))
                    stack.append((indent + 2, child))
                if separator and value.strip():
                    stack.append((indent, item))
            else:
                container.append(_parse_scalar(item_text))
            index += 1
            continue

        assert isinstance(container, dict)
        key, separator, value = stripped.partition(":")
        assert separator
        if value.strip() == "|":
            block_indent: int | None = None
            block_lines: list[str] = []
            index += 1
            while index < len(lines):
                block_line = lines[index]
                if not block_line.strip():
                    next_block_line = _next_meaningful_line(lines, index + 1)
                    if next_block_line is None:
                        break
                    next_indent = len(next_block_line) - len(next_block_line.lstrip(" "))
                    if next_indent <= indent:
                        break
                    block_lines.append("")
                    index += 1
                    continue
                current_indent = len(block_line) - len(block_line.lstrip(" "))
                if current_indent <= indent:
                    break
                if block_indent is None:
                    block_indent = current_indent
                block_lines.append(block_line[block_indent:])
                index += 1
            container[key] = "\n".join(block_lines) + "\n"
            continue
        if value.strip():
            container[key] = _parse_scalar(value)
            index += 1
            continue

        next_line = _next_meaningful_line(lines, index + 1)
        child = [] if next_line and next_line.strip().startswith("- ") else {}
        container[key] = child
        stack.append((indent, child))
        index += 1

    return root


def _release_workflow() -> dict[str, Any]:
    return _parse_workflow_yaml(REPO_ROOT / ".github" / "workflows" / "release.yml")


def _build_job(workflow: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], cast(dict[str, Any], workflow["jobs"])["build"])


def _steps_by_name(build_job: dict[str, Any]) -> dict[str, dict[str, Any]]:
    steps = cast(list[dict[str, Any]], build_job["steps"])
    return {cast(str, step["name"]): step for step in steps}


def _matrix_by_platform(build_job: dict[str, Any]) -> dict[str, dict[str, Any]]:
    strategy = cast(dict[str, Any], build_job["strategy"])
    matrix = cast(dict[str, Any], strategy["matrix"])
    entries = cast(list[dict[str, Any]], matrix["include"])
    return {cast(str, entry["name"]): entry for entry in entries}


def _artifact_globs(entry: dict[str, Any]) -> list[str]:
    return cast(str, entry["artifact-glob"]).splitlines()


def _checksum_inputs(entry: dict[str, Any]) -> list[str]:
    return [
        pattern.removeprefix("frontend/release/")
        for pattern in _artifact_globs(entry)
        if not pattern.startswith("frontend/release/checksums-")
    ]


def _bash_checksum_patterns(run: str) -> set[str]:
    match = re.search(r"for pattern in (?P<patterns>.*?); do", run)
    assert match is not None
    return set(match.group("patterns").split())


def _powershell_checksum_patterns(run: str) -> set[str]:
    return set(re.findall(r'\$_.Name -(?:like|eq) "([^"]+)"', run))


def test_release_workflow_matrix_matches_supported_platforms() -> None:
    matrix = _matrix_by_platform(_build_job(_release_workflow()))

    assert matrix == {
        "linux": {
            "name": "linux",
            "os": "ubuntu-latest",
            "package-script": "dist:linux",
            "artifact-name": "gofer-flow-linux",
            "artifact-glob": (
                "frontend/release/*.AppImage\n"
                "frontend/release/*.AppImage.blockmap\n"
                "frontend/release/*.deb\n"
                "frontend/release/*.rpm\n"
                "frontend/release/latest-linux.yml\n"
                "frontend/release/gof-linux-x64\n"
                "frontend/release/checksums-linux.txt\n"
            ),
        },
        "windows": {
            "name": "windows",
            "os": "windows-latest",
            "package-script": "dist:win",
            "artifact-name": "gofer-flow-windows",
            "artifact-glob": (
                "frontend/release/*.exe\n"
                "frontend/release/*.exe.blockmap\n"
                "frontend/release/latest.yml\n"
                "frontend/release/checksums-windows.txt\n"
            ),
        },
        "macos": {
            "name": "macos",
            "os": "macos-latest",
            "package-script": "dist:mac",
            "artifact-name": "gofer-flow-macos",
            "artifact-glob": (
                "frontend/release/*.dmg\n"
                "frontend/release/*.dmg.blockmap\n"
                "frontend/release/*.zip\n"
                "frontend/release/*.zip.blockmap\n"
                "frontend/release/latest-mac.yml\n"
                "frontend/release/gof-macos-*\n"
                "frontend/release/checksums-macos.txt\n"
            ),
        },
    }


def test_release_workflow_cli_steps_match_documented_artifact_names() -> None:
    workflow = _release_workflow()
    steps = _steps_by_name(_build_job(workflow))
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf8")
    documented_cli_names = set(re.findall(r"- (?:Linux|Windows|macOS): `([^`]+)`", readme))

    linux_copy = cast(str, steps["Copy Linux CLI artifact"]["run"])
    assert "cp dist/gof frontend/release/gof-linux-x64" in linux_copy
    assert "chmod +x frontend/release/gof-linux-x64" in linux_copy
    assert "gof-linux-x64" in documented_cli_names

    linux_package = cast(str, steps["Build Linux CLI packages"]["run"])
    assert linux_package == "scripts/package-cli-linux.sh dist/gof frontend/release"

    windows_copy = cast(str, steps["Copy Windows CLI artifact"]["run"])
    assert windows_copy == "Copy-Item dist/gof.exe frontend/release/gof-windows-x64.exe"
    assert "gof-windows-x64.exe" in documented_cli_names

    macos_copy = cast(str, steps["Copy macOS CLI artifact"]["run"])
    assert 'cp dist/gof "frontend/release/gof-macos-${artifact_arch}"' in macos_copy
    assert 'chmod +x "frontend/release/gof-macos-${artifact_arch}"' in macos_copy
    assert "gof-macos-<arch>" in documented_cli_names


def test_release_workflow_uploads_expected_artifacts_and_checksums() -> None:
    workflow = _release_workflow()
    build_job = _build_job(workflow)
    matrix = _matrix_by_platform(build_job)
    steps = _steps_by_name(build_job)

    assert _artifact_globs(matrix["linux"]) == [
        "frontend/release/*.AppImage",
        "frontend/release/*.AppImage.blockmap",
        "frontend/release/*.deb",
        "frontend/release/*.rpm",
        "frontend/release/latest-linux.yml",
        "frontend/release/gof-linux-x64",
        "frontend/release/checksums-linux.txt",
    ]
    assert _artifact_globs(matrix["windows"]) == [
        "frontend/release/*.exe",
        "frontend/release/*.exe.blockmap",
        "frontend/release/latest.yml",
        "frontend/release/checksums-windows.txt",
    ]
    assert _artifact_globs(matrix["macos"]) == [
        "frontend/release/*.dmg",
        "frontend/release/*.dmg.blockmap",
        "frontend/release/*.zip",
        "frontend/release/*.zip.blockmap",
        "frontend/release/latest-mac.yml",
        "frontend/release/gof-macos-*",
        "frontend/release/checksums-macos.txt",
    ]

    for platform, step_name in (
        ("linux", "Generate Linux checksums"),
        ("macos", "Generate macOS checksums"),
    ):
        checksum_run = cast(str, steps[step_name]["run"])
        assert _bash_checksum_patterns(checksum_run) == set(
            _checksum_inputs(matrix[platform])
        )
        assert f"checksums-{platform}.txt" in checksum_run

    windows_checksum_run = cast(str, steps["Generate Windows checksums"]["run"])
    assert _powershell_checksum_patterns(windows_checksum_run) == set(
        _checksum_inputs(matrix["windows"])
    )
    assert "checksums-windows.txt" in windows_checksum_run


def test_release_workflow_publication_and_artifact_upload_contract() -> None:
    steps = _steps_by_name(_build_job(_release_workflow()))

    workflow_upload = steps["Upload workflow artifacts"]
    assert workflow_upload["uses"] == "actions/upload-artifact@v4"
    assert workflow_upload["with"] == {
        "name": "${{ matrix.artifact-name }}",
        "path": "${{ matrix.artifact-glob }}",
        "if-no-files-found": "error",
    }

    release_upload = steps["Upload GitHub release artifacts"]
    assert release_upload["if"] == "startsWith(github.ref, 'refs/tags/')"
    assert release_upload["uses"] == "softprops/action-gh-release@v2"
    assert release_upload["with"] == {"files": "${{ matrix.artifact-glob }}"}
