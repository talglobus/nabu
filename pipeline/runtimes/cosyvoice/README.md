# CosyVoice runtime: disabled

Navoiy/CosyVoice generation is quarantined. The main pipeline refuses to start or automatically
install this runtime, and the worker's command-line entry point exits before downloading models
or importing their code. Existing course audio still plays and compiles normally.

Do not run `uv sync` or import and call the legacy worker manually. Its manifest and lockfile
remain as a record of the environment used to generate the committed clips, not a supported setup.

The pinned PyTorch 2.3.1 is affected by
[CVE-2025-32434](https://github.com/pytorch/pytorch/security/advisories/GHSA-53q9-r3pm-6pq6):
`weights_only=True` does not prevent code execution from a malicious checkpoint in this version.
Other locked dependencies also have advisories, including Transformers, Diffusers, Lightning,
ModelScope, gdown, fsspec, Hydra, PyArrow, and setuptools.

Re-enabling this runtime requires a compatible dependency upgrade, a fresh advisory scan, review
of the pinned CosyVoice and checkpoint-normalizer Python sources, and a synthesis regression test
in an isolated environment without credentials. Revision pins and checksums establish identity;
they do not establish that executable model code is safe. There is no environment-variable bypass.
