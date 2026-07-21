# Third-party software

The local renderer contains exact, unmodified runtime files from:

- **MathJax 4.1.3** (`@mathjax/src`), from
  <https://github.com/mathjax/MathJax-src/tree/4.1.3>.
- **MathJax New Computer Modern font 4.1.3**
  (`@mathjax/mathjax-newcm-font`), from
  <https://github.com/mathjax/MathJax-fonts/tree/4.1.3>.

Both packages use the Apache License 2.0. The complete license is packaged at
`resources/mathjax/LICENSE`. Exact npm integrity values, file digests, and
provenance are recorded in `package-lock.json` and `artifacts.lock.json` in the
matching source release. `scripts/vendor-mathjax.js --check` verifies that the
packaged files, including every reachable dynamic SVG font module, match those
npm releases byte-for-byte.

The repository's GPL-3.0-only license covers the original extension code and
does not replace the third-party terms.
