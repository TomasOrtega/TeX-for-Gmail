# Security policy

## Supported versions

Security fixes are made on the default branch and included in the next
release. Only the latest published version is supported.

## Reporting a vulnerability

Please use
[GitHub's private vulnerability reporting](https://github.com/TomasOrtega/TeX-for-Gmail/security/advisories/new).
Do not include exploit details or private email content in a public issue.

Include the affected version, Firefox version, reproduction steps, and the
impact you observed. Reports involving LaTeX input that escapes the worker,
access to Gmail data outside the active editor, remote code loading, or
dependency substitution are especially useful.

## Release integrity

The extension is designed to run without runtime network dependencies other
than Gmail itself. Generated and vendored artifacts are recorded in
`artifacts.lock.json` and checked by `npm run verify:release`.
