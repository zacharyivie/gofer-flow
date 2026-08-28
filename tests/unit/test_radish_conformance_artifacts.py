from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from gofer.radish.compiler import CompileContext, RadishCompiler, ReferencedWorkflow
from gofer.radish.contracts import canonical_json_bytes
from gofer.radish.diagnostics import RadishCompileError
from gofer.radish.parser import parse_radish
from gofer.radish.provider_contracts import load_provider_contracts

PROJECT_ROOT = Path(__file__).parents[2]
RADISH_ROOT = PROJECT_ROOT / "radish"
CONTRACT_FIXTURES = RADISH_ROOT / "conformance" / "contracts"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def contract_compiler() -> tuple[RadishCompiler, dict[str, Any]]:
    compiler = RadishCompiler.from_paths(
        schema_root=RADISH_ROOT / "schemas",
        contract_paths=sorted((RADISH_ROOT / "contracts").glob("*.json")),
    )
    providers = load_provider_contracts(
        RADISH_ROOT / "schemas" / "provider-contract.schema.json",
        sorted((RADISH_ROOT / "providers").glob("*.json")),
    )
    return compiler, providers


CONTRACT_CASES = load_json(CONTRACT_FIXTURES / "manifest.json")["cases"]


def test_machine_schemas_are_valid_draft_2020_12() -> None:
    schema_paths = sorted((RADISH_ROOT / "schemas").glob("*.schema.json"))

    assert {path.name for path in schema_paths} == {
        "ast.schema.json",
        "diagnostic.schema.json",
        "ir.schema.json",
        "node-contract.schema.json",
        "provider-contract.schema.json",
        "run.schema.json",
        "workflow-metadata.schema.json",
        "workspace-registry.schema.json",
    }
    for schema_path in schema_paths:
        Draft202012Validator.check_schema(load_json(schema_path))


def test_bash_vertical_slice_matches_ast_and_ir_schemas() -> None:
    fixture = RADISH_ROOT / "conformance" / "valid" / "bash-environment"
    ast_schema = load_json(RADISH_ROOT / "schemas" / "ast.schema.json")
    ir_schema = load_json(RADISH_ROOT / "schemas" / "ir.schema.json")
    ast = load_json(fixture / "expected-ast.json")
    ir = load_json(fixture / "expected-ir.json")

    Draft202012Validator(ast_schema).validate(ast)
    Draft202012Validator(ir_schema).validate(ir)

    source_digest = hashlib.sha256((fixture / "workflow.rad").read_bytes()).hexdigest()
    assert ir["source"]["source_fingerprint"] == f"sha256:{source_digest}"
    assert ir["workflow"]["timeout_ms"] == 2 * 60 * 60 * 1000
    assert ir["nodes"][0]["bindings"][0]["delivery"] == {
        "kind": "environment",
        "name": "BUILD_MODE",
        "encoding": "string_or_canonical_json",
        "precedence": "over_node_and_inherited_environment",
    }


def test_public_workflow_output_fixture_has_frozen_complete_ast_and_ir() -> None:
    fixture = RADISH_ROOT / "conformance" / "valid" / "workflow-public-output"
    expected = load_json(fixture / "expected-artifacts.json")
    source = (fixture / "workflow.rad").read_text(encoding="utf-8")
    compiler = RadishCompiler.from_paths(
        schema_root=RADISH_ROOT / "schemas",
        contract_paths=[RADISH_ROOT / "contracts" / "bash-command.json"],
    )

    result = compiler.compile(
        source,
        CompileContext(expected["workflow_id"], Path(expected["project_root"])),
    )

    assert hashlib.sha256(canonical_json_bytes(result.ast)).hexdigest() == expected["ast_sha256"]
    assert hashlib.sha256(canonical_json_bytes(result.ir)).hexdigest() == expected["ir_sha256"]
    assert result.ir["workflow"]["outputs"][0]["name"] == "build-log"


def test_expected_diagnostics_match_schema_and_source_positions() -> None:
    diagnostic_schema = load_json(RADISH_ROOT / "schemas" / "diagnostic.schema.json")
    diagnostic_files = sorted((RADISH_ROOT / "conformance").glob("**/expected-diagnostics.json"))

    assert diagnostic_files
    for diagnostic_file in diagnostic_files:
        source = (diagnostic_file.parent / "workflow.rad").read_text(encoding="utf-8")
        diagnostics = load_json(diagnostic_file)
        for diagnostic in diagnostics:
            Draft202012Validator(diagnostic_schema).validate(diagnostic)
            for position_name in ("start", "end"):
                position = diagnostic["span"][position_name]
                prefix = source[: position["offset"]]
                assert position["line"] == prefix.count("\n") + 1
                assert position["column"] == len(prefix.rsplit("\n", 1)[-1]) + 1


def test_invalid_conformance_cases_do_not_publish_expected_ir() -> None:
    invalid_cases = sorted((RADISH_ROOT / "conformance" / "invalid").glob("*/workflow.rad"))

    assert invalid_cases
    for source_path in invalid_cases:
        assert not (source_path.parent / "expected-ir.json").exists()
        diagnostics = load_json(source_path.parent / "expected-diagnostics.json")
        assert diagnostics
        assert all(item["severity"] == "error" for item in diagnostics)


@pytest.mark.parametrize("node_type", sorted(CONTRACT_CASES))
def test_machine_contract_source_fixtures_have_frozen_ast_and_ir(node_type: str) -> None:
    case = CONTRACT_CASES[node_type]
    source = (CONTRACT_FIXTURES / node_type / "valid.rad").read_text(encoding="utf-8")
    ast = parse_radish(source)

    assert hashlib.sha256(canonical_json_bytes(ast)).hexdigest() == case["ast_sha256"]

    compiler, providers = contract_compiler()
    referenced_workflows = {}
    if node_type == "workflow":
        child_path = CONTRACT_FIXTURES / "workflow" / "child" / "workflow.rad"
        child = compiler.compile(
            child_path.read_text(encoding="utf-8"),
            CompileContext(
                "contract-child",
                Path("/fixture/project"),
                entrypoint="child/workflow.rad",
                provider_contracts=providers,
            ),
        )
        referenced_workflows[("project_path", "child/workflow.rad")] = ReferencedWorkflow(
            "project_path",
            "child/workflow.rad",
            Path("/fixture/project/child/workflow.rad"),
            child.ir,
        )
    context = CompileContext(
        f"contract-{node_type}",
        Path("/fixture/project"),
        provider_contracts=providers,
        referenced_workflows=referenced_workflows,
    )
    if case["outcome"] == "unsupported":
        with pytest.raises(RadishCompileError) as caught:
            compiler.compile(source, context)
        assert [item.code for item in caught.value.diagnostics] == [
            "RADISH_COMPILER_CAPABILITY_MISSING"
        ]
        return

    result = compiler.compile(source, context)
    assert hashlib.sha256(canonical_json_bytes(result.ir)).hexdigest() == case["ir_sha256"]
    assert result.ir["nodes"][0]["contract"]["node_type"] == node_type


@pytest.mark.parametrize(
    "node_type",
    sorted(name for name, case in CONTRACT_CASES.items() if "invalid_code" in case),
)
def test_machine_contract_invalid_source_fixtures_have_stable_diagnostics(
    node_type: str,
) -> None:
    case = CONTRACT_CASES[node_type]
    source = (CONTRACT_FIXTURES / node_type / "invalid.rad").read_text(encoding="utf-8")
    compiler, providers = contract_compiler()

    with pytest.raises(RadishCompileError) as caught:
        compiler.compile(
            source,
            CompileContext(
                f"invalid-contract-{node_type}",
                Path("/fixture/project"),
                provider_contracts=providers,
            ),
        )

    assert case["invalid_code"] in {item.code for item in caught.value.diagnostics}


@pytest.mark.parametrize(
    "fields",
    [
        "  path: input.txt",
        '  path: "input.txt"\n  timeout: input.timeout',
    ],
)
def test_literal_field_reference_reports_diagnostic_instead_of_crashing(fields: str) -> None:
    source = f"""Radish: 1
Workflow:
  name: Ambiguous path
Node example:
  type: read-file
{fields}
"""
    compiler, providers = contract_compiler()

    with pytest.raises(RadishCompileError) as caught:
        compiler.compile(
            source,
            CompileContext(
                "reference-path", Path("/fixture/project"), provider_contracts=providers
            ),
        )

    assert "RADISH_INVALID_FIELD_VALUE" in {item.code for item in caught.value.diagnostics}
