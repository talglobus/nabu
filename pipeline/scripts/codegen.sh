#!/bin/sh
set -eu

# Preserve the generator's exit status while always removing the temporary schema.
trap 'rm -f .bundle.schema.json' EXIT
node ../packages/schema/scripts/emit-bundle.ts > .bundle.schema.json
uv run --frozen datamodel-codegen \
  --input .bundle.schema.json \
  --input-file-type jsonschema \
  --output src/nabu/schema/models.py \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.12 \
  --use-annotated --use-type-alias --enum-field-as-literal all \
  --use-standard-collections --use-union-operator --use-title-as-name \
  --use-schema-description --field-constraints --enable-faux-immutability \
  --strict-nullable --disable-timestamp \
  --custom-file-header-path scripts/models-header.txt \
  --formatters ruff-format ruff-check
