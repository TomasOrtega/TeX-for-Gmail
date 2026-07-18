#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v emcc >/dev/null
test -f pdftex.bc

emcc -v -O3 -s ERROR_ON_UNDEFINED_SYMBOLS=0 -s INVOKE_RUN=0 \
    --pre-js pre.js --post-js post.js -o pdflatex.js \
    -s MODULARIZE=1 -s EXPORT_NAME="'pdflatex'" -s EXTRA_EXPORTED_RUNTIME_METHODS='["FS", "callMain"]' -s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE='["memcpy", "memset", "malloc", "free", "emscripten_get_heap_size", "$ERRNO_CODES"]' \
    -s TOTAL_MEMORY=8388608 -s WASM_MEM_MAX=268435456 -s ALLOW_MEMORY_GROWTH=1 pdftex.bc

install -m 0644 pdflatex.wasm ../../chrome-extension/resources/wasm/pdflatex.wasm
install -m 0644 pdflatex.js ../../chrome-extension/resources/scripts/pdflatex.js

cmp pdflatex.wasm ../../chrome-extension/resources/wasm/pdflatex.wasm
cmp pdflatex.js ../../chrome-extension/resources/scripts/pdflatex.js

echo "Rebuild complete. Review the diff, then update artifacts.lock.json."
