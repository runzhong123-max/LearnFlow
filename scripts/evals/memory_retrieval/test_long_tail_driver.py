"""A failed rerun must never alter archived experimental evidence."""
from argparse import Namespace
from pathlib import Path
import pytest
import run_long_tail


def test_existing_output_is_rejected_before_any_runner_or_provenance_write(tmp_path, monkeypatch):
    output = tmp_path / "results"
    output.mkdir()
    witness = output / "source-provenance.json"
    witness.write_bytes(b'{"original": true}\n')
    before = {p.name: p.read_bytes() for p in output.iterdir()}
    def forbidden(*args, **kwargs):
        raise AssertionError("Runner must not start on an existing evidence directory")
    monkeypatch.setattr(run_long_tail.runner, "run", forbidden)
    args = Namespace(repo=tmp_path, host=tmp_path, output=output)
    with pytest.raises(FileExistsError):
        run_long_tail.run(args)
    assert {p.name: p.read_bytes() for p in output.iterdir()} == before
