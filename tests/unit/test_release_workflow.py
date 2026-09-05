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
    return _parse_workflow_yaml(REPO_ROOT / ".github" / "workflows" / "release-build.yml")


def _entry_workflow(name: str) -> dict[str, Any]:
    return _parse_workflow_yaml(REPO_ROOT / ".github" / "workflows" / name)


def _job(workflow: dict[str, Any], name: str) -> dict[str, Any]:
    return cast(dict[str, Any], cast(dict[str, Any], workflow["jobs"])[name])


def _build_job(workflow: dict[str, Any]) -> dict[str, Any]:
    return _job(workflow, "build")


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


def test_main_and_tag_entries_call_the_same_release_build() -> None:
    dry_run = _job(_entry_workflow("release-dry-run.yml"), "release-dry-run")
    tagged_release = _job(_entry_workflow("release.yml"), "release-build")

    assert dry_run["uses"] == "./.github/workflows/release-build.yml"
    assert dry_run["with"] == {"checkout_ref": "${{ github.sha }}"}
    assert tagged_release["uses"] == "./.github/workflows/release-build.yml"
    assert tagged_release["with"] == {"checkout_ref": "${{ github.ref }}"}


def test_only_tag_entry_can_publish() -> None:
    dry_run = _entry_workflow("release-dry-run.yml")
    tagged_release = _entry_workflow("release.yml")

    assert dry_run["permissions"] == {"contents": "read"}
    assert "publish" not in cast(dict[str, Any], dry_run["jobs"])
    assert tagged_release["permissions"] == {"contents": "read"}

    publish_job = _job(tagged_release, "publish")
    assert publish_job["needs"] == "release-build"
    assert publish_job["permissions"] == {"contents": "write"}


def test_release_workflow_matrix_matches_supported_platforms() -> None:
    matrix = _matrix_by_platform(_build_job(_release_workflow()))

    assert matrix == {
        "linux": {
            "name": "linux",
            "os": "ubuntu-24.04",
            "electron_builder_args": "--linux AppImage deb rpm",
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
            "electron_builder_args": "--win nsis",
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
            "electron_builder_args": "--mac dmg",
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
        assert _bash_checksum_patterns(checksum_run) == set(_checksum_inputs(matrix[platform]))
        assert f"checksums-{platform}.txt" in checksum_run

    windows_checksum_run = cast(str, steps["Generate Windows checksums"]["run"])
    assert _powershell_checksum_patterns(windows_checksum_run) == set(
        _checksum_inputs(matrix["windows"])
    )
    assert "checksums-windows.txt" in windows_checksum_run


def test_release_workflow_publication_and_artifact_upload_contract() -> None:
    workflow = _release_workflow()
    build_job = _build_job(workflow)
    build_steps = _steps_by_name(build_job)

    assert build_job["needs"] == "validate"
    workflow_upload = build_steps["Upload workflow artifacts"]
    assert workflow_upload["uses"] == "actions/upload-artifact@v4"
    assert workflow_upload["with"] == {
        "name": "${{ matrix.artifact-name }}",
        "path": "${{ matrix.artifact-glob }}",
        "if-no-files-found": "error",
    }

    assert "Upload GitHub release artifacts" not in build_steps

    assert "publish" not in cast(dict[str, Any], workflow["jobs"])

    publish_job = _job(_entry_workflow("release.yml"), "publish")
    assert publish_job["runs-on"] == "ubuntu-24.04"
    publish_steps = _steps_by_name(publish_job)
    download = publish_steps["Download packaged artifacts"]
    assert download["uses"] == "actions/download-artifact@v4"
    assert download["with"] == {
        "pattern": "gofer-flow-*",
        "path": "release-artifacts",
        "merge-multiple": True,
    }
    release_upload = publish_steps["Upload GitHub release artifacts"]
    assert release_upload["uses"] == "softprops/action-gh-release@v2"
    assert release_upload["with"] == {
        "files": "release-artifacts/*",
        "fail_on_unmatched_files": True,
    }


def test_release_validation_gates_packages_and_checks_tag_versions() -> None:
    workflow = _release_workflow()
    validation_job = _job(workflow, "validate")
    validation_steps = _steps_by_name(validation_job)

    assert validation_job["runs-on"] == "ubuntu-24.04"
    assert validation_steps["Verify tag matches package versions"]["if"] == (
        "startsWith(inputs.checkout_ref, 'refs/tags/v')"
    )
    version_check = cast(str, validation_steps["Verify tag matches package versions"]["run"])
    assert 'Path("pyproject.toml")' in version_check
    assert 'Path("frontend/package.json")' in version_check
    assert 'os.environ["CHECKOUT_REF"].removeprefix("refs/tags/v")' in version_check
    assert validation_steps["Lint frontend source"]["run"] == "npm run lint"
    assert validation_steps["Test frontend"]["run"] == "npm test"
    assert validation_steps["Browser-test workflow studio"]["run"] == (
        "xvfb-run -a npm run test:browser"
    )

    build_steps = _steps_by_name(_build_job(workflow))
    assert "Lint frontend source" not in build_steps
    assert "Test frontend" not in build_steps
    assert "Browser-test workflow studio" not in build_steps
