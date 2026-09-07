"""Operational provenance is bounded, coherent and never independent mastery."""
from copy import deepcopy

import pytest
from pydantic import ValidationError

import app  # Activate the host's shared-package bootstrap in source checkouts.
from learnflow_core.project_guidance_schema import DeviceReportInput


def source(**changes):
    return {"schema_version": "learnflow.engineering-provenance.v1", "authority": "device_reported",
            "independent_completion_verified": False, "assisted": True, "truncated": False,
            "runs": [{"run_id": 1, "checkpoint_id": 9, "status": "applied", "snapshot_hash": "a" * 64,
                      "result_hash": "b" * 64, "assistance_policy": {"mode": "implementation", "revision": 2,
                      "execution_mode": "workspace_write"}, "association": "exact_files", "matching_paths": ["main.c"]}], **changes}


def report(**changes):
    return {"schema_version": "learnflow.device-report.v1", "client_action_id": "report-1", "checkpoint_id": 9,
            "action": "files", "status": "completed", "snapshot_hash": "c" * 64, "exit_code": None,
            "summary": "File versions only", "manifest": [{"path": "main.c", "sha256": "d" * 64, "size": 20}],
            "steps": [], **changes}


def test_legacy_report_serialization_and_hash_inputs_do_not_change():
    from learnflow_core.project_guidance import digest
    body = report()
    old = DeviceReportInput.model_validate(body)
    assert old.engineering_provenance is None
    assert old.model_dump() == body
    assert DeviceReportInput.model_validate({**body, "engineering_provenance": None}).model_dump() == body
    assert digest(old.model_dump()) == digest(body)


def test_report_allows_exact_versions_and_conservative_prior_project_history():
    evidence = source()
    assert DeviceReportInput.model_validate(report(engineering_provenance=evidence)).model_dump()["engineering_provenance"] == evidence
    evidence["runs"][0].update(checkpoint_id=None, assistance_policy=None, association="applied_project_history", matching_paths=[])
    parsed = DeviceReportInput.model_validate(report(engineering_provenance=evidence))
    assert parsed.engineering_provenance.assisted
    assert parsed.engineering_provenance.independent_completion_verified is False
    # A past stage revision is a historical snapshot; the ingestion service
    # separately verifies any supplied checkpoint belongs to this project.
    evidence["runs"][0].update(checkpoint_id=8)
    assert DeviceReportInput.model_validate(report(engineering_provenance=evidence))
    empty = source(assisted=False, runs=[])
    assert DeviceReportInput.model_validate(report(engineering_provenance=empty)).engineering_provenance.independent_completion_verified is False


@pytest.mark.parametrize("changes", [
    {"schema_version": "learnflow.engineering-provenance.v2"}, {"authority": "verified"},
    {"independent_completion_verified": True}, {"independent_completion_verified": 0},
    {"assisted": False}, {"assisted": 1}, {"truncated": "false"}, {"truncated": True},
    {"source_code": "private bytes"},
])
def test_provenance_envelope_rejects_claims_or_unbounded_extra_data(changes):
    with pytest.raises(ValidationError):
        DeviceReportInput.model_validate(report(engineering_provenance=source(**changes)))


@pytest.mark.parametrize("changes", [
    {"run_id": True}, {"run_id": 0}, {"run_id": "1"}, {"checkpoint_id": 0}, {"checkpoint_id": "9"},
    {"status": "running"}, {"status": "failed"}, {"snapshot_hash": "wrong"}, {"result_hash": "e" * 65},
    {"matching_paths": []}, {"matching_paths": ["other.c"]}, {"matching_paths": ["../main.c"]},
    {"matching_paths": ["/main.c"]}, {"matching_paths": ["./main.c"]}, {"matching_paths": ["a\\main.c"]},
    {"matching_paths": ["x" * 501]}, {"matching_paths": ["main.c", "main.c"]},
    {"status": "completed", "association": "applied_project_history", "matching_paths": []},
    {"association": "applied_project_history"}, {"stdout": "private logs"},
])
def test_provenance_run_requires_valid_scope_state_hash_and_manifest_paths(changes):
    evidence = source()
    evidence["runs"][0].update(changes)
    with pytest.raises(ValidationError):
        DeviceReportInput.model_validate(report(engineering_provenance=evidence))


@pytest.mark.parametrize("changes", [
    {"revision": -1}, {"revision": True}, {"revision": "2"}, {"revision": 2**53},
    {"mode": "unlimited"}, {"mode": "direction"}, {"execution_mode": "read_only"}, {"extra": True},
    {"mode": "steps", "execution_mode": "read_only"},
])
def test_provenance_policy_is_a_strict_historical_permission_snapshot(changes):
    evidence = source()
    evidence["runs"][0]["assistance_policy"].update(changes)
    with pytest.raises(ValidationError):
        DeviceReportInput.model_validate(report(engineering_provenance=evidence))


def test_provenance_maximum_twenty_distinct_runs_and_bounded_paths():
    evidence = source()
    evidence["runs"] = [{**deepcopy(evidence["runs"][0]), "run_id": index + 1} for index in range(20)]
    evidence["truncated"] = True
    assert DeviceReportInput.model_validate(report(engineering_provenance=evidence))
    evidence["runs"].append({**evidence["runs"][0], "run_id": 21})
    with pytest.raises(ValidationError):
        DeviceReportInput.model_validate(report(engineering_provenance=evidence))
    evidence = source()
    evidence["runs"] *= 2
    with pytest.raises(ValidationError):
        DeviceReportInput.model_validate(report(engineering_provenance=evidence))
