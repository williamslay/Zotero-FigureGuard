#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python -m unittest discover -s tests -v
python scripts/inspect_pdf.py fixture/PipeBWrite.pdf --page 5 --out reports/fixture-latest.json
