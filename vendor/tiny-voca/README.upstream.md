# tiny-voca in plain JavaScript

An experiment: the model and its phonemizer in plain scripts, with no
libraries. No ONNX Runtime, no WebAssembly, no Pyodide, no npm packages. It
reads one GGUF file of 8 MB, turns text into phonemes and makes sound.

- `tiny-voca.js`: the GGUF reader and the model. Open it and read from the top.
- `dizione/`: the phonemizer, a port of [dizione](https://github.com/n4ze3m/dizione). See below.
- `say.mjs`: the same from the command line, with Node or Bun. No browser.
- `text.js`: cuts a text into sentences and writes the WAV; the page and `say.mjs` share it.
- `index.html`: the page. Type a text, pick a voice, press Play.
  Each sentence plays as soon as it is made, and the whole clip can be saved as a WAV file.
- `pack.mjs`: makes the one file the page reads, `tiny-voca.gguf`.
- `test/`: the checks against PyTorch and against Python dizione.

## Try it

```
cd js
python3 -m http.server 8000
```

Open http://localhost:8000. The page downloads one file,
[`gguf/tiny-voca-js.gguf`](https://huggingface.co/n4ze3m/tiny-voca/tree/main/gguf),
from Hugging Face and nothing else.

To make that file yourself and use your own copy:

```
node js/pack.mjs tiny-voca-orig.gguf path/to/dizione/src/dizione/data js/tiny-voca.gguf
```

It is made from the float32 file on Hugging Face and the small tables of
dizione. Open the page with `?file=tiny-voca.gguf` to read it.

## From the command line

```
node js/say.mjs "Hello! This is tiny voca." --voice M2 --output hello.wav
bun js/say.mjs "Hello! This is tiny voca." --voice F2 --output hello.wav
```

No browser and no packages to install. It reads `js/tiny-voca.gguf` if it is
there, or downloads the file from Hugging Face; `--file` takes another path or
address. Node and Bun write the same WAV, byte for byte.

Speed on an Apple M5, one thread, over the 20 test utterances (79 s of audio):

| | Times real time | Ready after | Peak memory |
|---|---|---|---|
| Node 24 | 9.7 | 192 ms | 238 MB |
| Bun 1.3 | 13.4 | 104 ms | 518 MB |

In your own code:

```js
import { readFileSync } from "node:fs";
import { readGGUF, TinyVoca } from "./tiny-voca.js";
import { fromGGUF } from "./dizione/engine.js";

const file = readGGUF(new Uint8Array(readFileSync("tiny-voca.gguf")).buffer);
const voca = new TinyVoca(file);
const phonemizer = await fromGGUF(file);

const { ids, stress } = phonemizer.phonemize("Hello! This is tiny voca.");
const { audio } = voca.synthesize(ids, stress, { voice: "M2" });
```

`audio` is a Float32Array at 24 kHz. One call reads one sentence; `say.mjs`
shows how a longer text is cut.

## Check against PyTorch

```
python js/test/reference.py --checkpoint tiny-voca.pt --output reference
node js/test/check.mjs tiny-voca-orig.gguf reference
```

The first line writes what PyTorch gives for the test sentences. The second
runs the same phonemes and the same noise through the JavaScript model and
prints, for each sentence and voice, whether the lengths are equal and how far
the waveform is.

## The phonemizer

`dizione/` turns text into phoneme ids and a stress value for each id. It must
give exactly what the Python dizione gives. It follows dizione with the two
fixes for letters with full stops ("U.S.A", "Ph.D.", "J. R. R. Tolkien") and
for a page after a number ("Chapter 3, p. 45").

- `normalize.js`: text to words: numbers, money, dates, units, abbreviations, signs.
- `pyre.js`: Python regular expressions and string methods, so `normalize.js` can stay line by line next to `normalize.py`.
- `engine.js`: the phonemizer: dictionary, endings, names, phrases, homographs, unknown words. `fromGGUF` builds it from the file.
- `g2p.js`: the small model that guesses unknown words.
- `align.js`, `convert.js`: letters lined up with phonemes, and ARPAbet turned into the phoneme set.
- `morphology.js`, `homographs.js`, `sentence.js`: endings, words with two readings, sentence stress.
- `symbols.js`: the symbols and their ids.
- `lexicon.js`: the packed dictionary.
- `tables.js`: reads the ten small tables (abbreviations, units, exceptions and so on).

All its data comes from the GGUF: the dictionary, the alignment table, the
homograph data, the unknown-word model and the ten small tables. The float32
file on Hugging Face has no tables, so the phonemizer needs a file made by
`pack.mjs`.

```
node js/test/vectors.mjs js/tiny-voca.gguf path/to/dizione/tests/vectors
```

This reads the test vectors of dizione (texts with the ids and stress they
must give) and prints how many texts differ. Today: 0 of 13,973. The vector
files are not copied here; give the folder.

`node js/test/dizione.mjs ids model.gguf texts.txt out.txt` writes the ids and
stress for a file with one text on each line.

`node js/test/dictionary.mjs js/tiny-voca.gguf path/to/vectors` measures the
sizes of the dictionary in several forms and what the unknown-word model does
at 16 and 8 bits. It runs the model over all 124,926 words and takes about 40
minutes on one core.

## The one file

`pack.mjs` turns the float32 file of 23.57 MB into `tiny-voca.gguf` of 7.99 MB.
It is an ordinary GGUF: the `gguf` Python package lists it. Three things
change.

The weights. The 44 large matrices of the transformer blocks are stored with
8 bits a weight, in the Q8_0 form of GGUF: every 32 weights share one scale
(16-bit float), and each weight is a whole number from -127 to 127 times that
scale. The scale is the largest weight of the 32, divided by 127. These are
the same numbers as in `tiny-voca-q8_0.gguf` on Hugging Face. Everything else
stays float32. On the 20 test utterances 19 keep the durations of PyTorch. An
earlier try with one scale for a whole row was 0.2 MB smaller but kept only
14 of 20: a row has weights of very different sizes, and one scale is too
coarse for the small ones.

The dictionary. In the float32 file it is a text of 3.45 MB, one word and its
phonemes on each line. `pack.mjs` stores it as `phonemizer/lexicon.packed.gz`
in 0.55 MB. The words are sorted, so each word is stored as the number of
bytes it shares with the word before and then the rest. The phonemes are
stored the same way, with one byte for each phoneme and its stress. The
result is gzipped, and the page reads it with `DecompressionStream`. Every
word and every pronunciation comes back the same.

The tables. The ten small text tables of dizione are put inside as they are.

`node js/test/clips.mjs file.gguf folder label 1 2` writes sentences 1 and 2
as WAV files.

## Memory

Once loaded, the model holds about 25 MB and the phonemizer about 21 MB.
Two things keep the peak near that.

The dictionary is unpacked one entry at a time into one small buffer that is
used again for every entry, so loading it makes no pile of short-lived arrays.

In `tiny-voca.js` the working arrays of a sentence are used again. `floats`
hands out an array and remembers it; `giveBack` puts the arrays made since a
mark on a spare list, where the next `floats` call of the same size finds
them. A transformer block gives its arrays back when it ends, and so does
each attention head. One long sentence asks for 116 MB of arrays this way and
only 13 MB are really made. Every array from `floats` is written in full
before it is read, so old numbers in it do not matter, and the sound is the
same sample for sample.
