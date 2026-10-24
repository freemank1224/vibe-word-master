"""Historical prototype generator. Surf now uses project recordings; do not use for production audio."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import shutil
import subprocess

root = Path(__file__).resolve().parents[2]
words = re.findall(r"answer: '([a-z]+)'", (root / "features/monster-surf/words.ts").read_text())
output = root / "public/monster-surf/audio"
output.mkdir(parents=True, exist_ok=True)

def build(word):
    path = output / f"{word}.m4a"
    subprocess.run([
        "/usr/bin/say", "-v", "Samantha", "-r", "145",
        "--file-format=m4af", "--data-format=aac", "-o", str(path), word,
    ], check=True, capture_output=True)
    # Strip the speech tool's 32 KB container padding without re-encoding.
    if shutil.which("ffmpeg"):
        compact = path.with_suffix(".compact.m4a")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-c", "copy", "-movflags", "+faststart", str(compact)], check=True)
        compact.replace(path)
    return path.stat().st_size

if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=4) as pool:
        sizes = list(pool.map(build, words))
    print(f"{len(sizes)} clips, {sum(sizes):,} bytes")
