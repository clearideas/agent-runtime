"""Port of ``packages/artifacts/src/index.test.ts`` (host-process provider)."""

from __future__ import annotations

import shutil

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.artifacts import ArtifactGenerationRequest, ArtifactGenerator, ArtifactRuntimeProfile
from clearideas_agent_runtime.sandbox.testing import HostProcessTestProvider

PYTHON = ArtifactRuntimeProfile(
    id="python",
    image="python:3.12-slim",
    language="python",
    extension="py",
    command="python3",
    args=lambda source: [source],
)


@pytest.mark.skipif(shutil.which("python3") is None, reason="needs python3")
async def test_generates_validates_and_names_a_document() -> None:
    code = "import os, zipfile\npath = os.path.join(os.environ['ARTIFACT_OUTPUT_DIRECTORY'], 'out.docx')\nos.makedirs(os.path.dirname(path), exist_ok=True)\nzipfile.ZipFile(path, 'w').writestr('word/document.xml', open(os.path.join(os.environ['ARTIFACT_INPUT_DIRECTORY'], 'data.txt')).read())\nprint(os.environ.get('SAFE'), os.environ.get('SECRET'))"
    generator = ArtifactGenerator(provider=HostProcessTestProvider(), allowed_environment=["SAFE"])
    result = await generator.generate(
        ArtifactGenerationRequest(
            artifact_type="docx",
            filename="report.docx",
            code=code,
            runtime=PYTHON,
            inputs=[{"filename": "data.txt", "content": "hello"}],
            environment={"SAFE": "yes", "SECRET": "no"},
            limits={"timeoutMs": 20_000},
        )
    )
    output = result["outputs"][0]
    assert (output["filename"], output["mediaType"]) == (
        "report.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    assert output["content"][:2] == b"PK"
    assert result["stdout"] == "yes None\n" and result["exitCode"] == 0 and result["provider"] == "host-process-test"


@pytest.mark.skipif(shutil.which("python3") is None, reason="needs python3")
async def test_rejects_invalid_outputs_and_path_filenames() -> None:
    generator = ArtifactGenerator(provider=HostProcessTestProvider())
    bad = "import os\nos.makedirs(os.environ['ARTIFACT_OUTPUT_DIRECTORY'], exist_ok=True)\nopen(os.path.join(os.environ['ARTIFACT_OUTPUT_DIRECTORY'], 'x.docx'), 'w').write('not zip')"
    with pytest.raises(Error, match="not a ZIP container"):
        await generator.generate(
            ArtifactGenerationRequest(
                artifact_type="docx", filename="x.docx", code=bad, runtime=PYTHON, limits={"timeoutMs": 20_000}
            )
        )
    with pytest.raises(Error, match="must not contain a path"):
        await generator.generate(
            ArtifactGenerationRequest(
                artifact_type="docx", filename="../x.docx", code="", runtime=PYTHON, limits={"timeoutMs": 1000}
            )
        )
    with pytest.raises(Error, match="exited with 3"):
        await generator.generate(
            ArtifactGenerationRequest(
                artifact_type="pdf",
                filename="x.pdf",
                code="raise SystemExit(3)",
                runtime=PYTHON,
                limits={"timeoutMs": 20_000},
            )
        )
