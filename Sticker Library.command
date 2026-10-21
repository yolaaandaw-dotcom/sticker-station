#!/bin/zsh
# Double-click: pull new pins from your board, process them, and open the review page.
cd "$(dirname "$0")"
.venv-lib/bin/python -I tools/stickerlib.py update && .venv-lib/bin/python -I tools/stickerlib.py review
