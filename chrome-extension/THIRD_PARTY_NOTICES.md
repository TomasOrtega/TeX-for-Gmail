# Third-party software

This extension contains generated or minified builds from these projects.
Exact file digests and the available provenance records are maintained in
`artifacts.lock.json` in the matching source release.

- **BrowserFS 2.0.0** (`browserfs.min.js`). The exact npm distribution is
  patched deterministically to remove two dynamic global-scope lookups that
  violate the extension content security policy. BrowserFS is distributed
  under the MIT license, with an Emscripten-derived file under the MIT/NCSA
  terms. The complete bundled notice is in `resources/browserfs/LICENSE`:
  <https://github.com/jvilk/BrowserFS/tree/bef1dc0b06021b04f66d90f2795e5cb8d25b7332>
- **MuPDF.js 1.28.0** (`resources/mupdf`). The files are copied from the exact
  `mupdf@1.28.0` npm package. MuPDF's open-source release is distributed under
  the GNU Affero General Public License. The complete license is in
  `resources/mupdf/LICENSE`:
  <https://github.com/ArtifexSoftware/mupdf/tree/205b8cf43551279d1215e88fe2845c5d595bade9>
- **Legacy pdfTeX WebAssembly build — provenance incomplete.** The packaged
  `pdflatex.js`, `pdflatex.wasm`, and retained `pdftex.bc` identify pdfTeX
  1.40.20 / TeX Live 2019. Embedded strings identify Xpdf 4.01, libpng 1.6.36,
  zlib 1.2.11, and Kpathsea 6.3.1. LLVM metadata identifies Clang 6.0.1 and
  historical Emscripten/fastcomp revisions recorded in `artifacts.lock.json`.
  Upstream pdfTeX is GPL-2.0-or-later and includes TeX and e-TeX portions that
  retain their original notices; Kpathsea is LGPL-2.1-or-later. The exact TeX
  Live source revision, dependency patch revisions, complete linked-component
  inventory, Emscripten system-library revisions, and reproducible build graph
  were not retained. This disclosure therefore does not purport to identify
  every applicable license or provide corresponding source.

- **TeX Live runtime subset.** The extension contains an unmodified selected
  runtime tree copied from `TeX-for-Gmail/TeX-Live-Files` commit
  `41bdfeea35d787cb2f314eea4d707bb32bc996ac` (release `v2019.0.4`). TeX Live is
  an aggregation rather than a work under one license; every included package,
  font, format input, and generated file retains its individual copyright and
  license terms. `resources/texlive/LICENSE.TL` is the TeX Live redistribution
  summary, not a replacement for those terms. The generated `pdflatex.fmt`
  embeds LaTeX and multilingual hyphenation data whose complete input and
  license inventory is not recoverable from the packaged binary. Runtime TeX
  files are local and are not downloaded from a CDN.

The repository's GPL-3.0 license covers the original extension code and does
not replace any third-party license.

The legacy pdfTeX build, prebuilt format, and incomplete TeX package/source
inventory are release blockers. See `docs/RELEASING.md` in the matching source
release before distributing this package.
