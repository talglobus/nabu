# 0090: Isolate development and quarantine the legacy model runtime

Status: Proposed

## Context

The API previously listened on all interfaces and used an inherited `DATABASE_URL` even when
started for development. Since startup runs migrations, an unrelated shell configuration could
change a real database. The optional CosyVoice environment pins vulnerable libraries and imports
downloaded Python code. A static review and OSV scan on 2026-11-09 found no evidence of deliberate
malware, but did identify these execution risks and vulnerable transitive dependencies.

## Decision

- `pnpm dev` starts the API with `--dev`. It always binds to `127.0.0.1` and uses
  `.data/dev-pglite`, unless `NABU_DEV_PGLITE` or `NABU_DEV_DATABASE_URL` deliberately overrides
  the database. Deployment variables do not affect these choices. End-to-end tests use the same
  mode with an in-memory database and explicitly clear the development Postgres URL.
- Standalone deployment also defaults to loopback. Compose explicitly sets `NABU_HOST=0.0.0.0`
  inside the container. Invalid ports and production test hooks fail before database startup.
- Navoiy/CosyVoice generation is disabled at both the launcher and worker CLI, before package
  installation or model downloads. Existing audio and fake-engine tests continue to work.
  The legacy lockfile is retained for provenance, not approved for installation. There is no
  opt-in flag that bypasses the quarantine.
- Transitive npm overrides move `glob`, `minimatch`, and `uuid` past the reviewed advisories.
  Keep the overrides until their parent dependencies require compatible patched versions.
- Ignore local database directories and local environment files in Git.

## Consequences and remaining work

Developers who used `.data/pglite` now get a separate development database. They can explicitly
select an existing development directory with `NABU_DEV_PGLITE`; no data is moved or deleted.
Network deployments outside Compose must explicitly set `NABU_HOST`.

CosyVoice needs a compatible dependency upgrade, review of executable model sources, and an
isolated synthesis regression test before re-enablement. A PyTorch-only version bump is not
sufficient to clear the other advisories or validate the old model stack.

The optional OmniVoice group pulls Pillow 12.3.0 through Gradio 6.31.0. Pillow 13.0.0 addresses
the scanned advisories, but Gradio requires Pillow `<13`; do not override that constraint without
compatibility testing. Ordinary compiler and app development do not install the OmniVoice group.

Advisory matches indicate affected versions, not proof that a vulnerable path is reachable in
this application. Neither a clean scan nor a checksum certifies downloaded code as trustworthy.
