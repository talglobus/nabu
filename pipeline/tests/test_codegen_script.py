"""Generation failures must reach CI even when temporary-file cleanup succeeds."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from .conftest import ROOT


@pytest.mark.parametrize(("node_status", "uv_status"), [(0, 0), (7, 0), (0, 9)])
def test_codegen_preserves_failure_and_cleans_up(
    tmp_path: Path, node_status: int, uv_status: int
) -> None:
    tools = tmp_path / "bin"
    tools.mkdir()
    for name, status in [("node", node_status), ("uv", uv_status)]:
        stub = tools / name
        stub.write_text(f"#!/bin/sh\necho ran > {name}.called\nexit {status}\n")
        stub.chmod(0o755)
    result = subprocess.run(
        ["sh", str(ROOT / "pipeline/scripts/codegen.sh")],
        cwd=tmp_path,
        env={**os.environ, "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"},
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == (node_status or uv_status)
    assert not (tmp_path / ".bundle.schema.json").exists()
    assert (tmp_path / "uv.called").exists() == (node_status == 0)
