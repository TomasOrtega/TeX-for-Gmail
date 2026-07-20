# Security policy

## Supported versions

Before the first store release, security reports against the default branch
are accepted. After release, security fixes are provided for the latest
published version and the default branch. Older releases are not supported.

## Reporting a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/TomasOrtega/TeX-for-Gmail/security/advisories/new).
Do not include exploit details, formula source from another person, or private
email content in a public issue.

Include the affected extension version or commit, browser and browser version,
reproduction steps, and observed impact. Reports involving renderer isolation,
access to Gmail data outside the active editor, remote code loading, content
security policy bypasses, or dependency substitution are especially useful.

For non-sensitive bugs, see [Support](SUPPORT.md).

## Release integrity

The extension has no runtime network dependency other than Gmail itself. The
MathJax renderer contains exact files from lockfile-pinned packages. Vendored
artifacts are recorded in `artifacts.lock.json`, checked by
`npm run verify:release`, and scanned with CodeQL and dependency auditing in
GitHub Actions.
