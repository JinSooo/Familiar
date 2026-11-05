#!/bin/sh
# Builds llama.cpp's llama-server as one static binary (Metal shaders embedded) for local
# embeddings, and copies it next to the other sidecars. Skips the build when the pinned version
# is already there. cmake runs through uvx so nothing is installed system-wide.
set -eu
tag=v0.9.0
root=$(cd "$(dirname "$0")/.." && pwd)
work="$root/llama/.build"
triple=$(rustc -vV | sed -n 's/^host: //p')
out="$root/src-tauri/binaries/llama-server-$triple"
built="$work/llama.cpp/build/bin/llama-server"
stamp="$work/version"

if [ ! -x "$built" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$tag" ]; then
  rm -rf "$work/llama.cpp"
  mkdir -p "$work/llama.cpp"
  # A tarball resumes after a dropped connection; a shallow clone starts over.
  archive="$work/llama.cpp-$tag.tar.gz"
  curl -fsSL --retry 8 --retry-all-errors -C - -o "$archive" \
    "https://github.com/ggml-org/llama.cpp/archive/refs/tags/$tag.tar.gz"
  tar -xzf "$archive" -C "$work/llama.cpp" --strip-components 1
  cd "$work/llama.cpp"
  uvx --from cmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON
  uvx --from cmake cmake --build build --target llama-server -j "$(sysctl -n hw.ncpu)"
  echo "$tag" > "$stamp"
fi
mkdir -p "$root/src-tauri/binaries"
cp "$built" "$out"
