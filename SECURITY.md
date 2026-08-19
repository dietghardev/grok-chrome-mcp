# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's
private vulnerability reporting on this repository
([Security → Report a vulnerability](https://github.com/dietghardev/grok-chrome-mcp/security/advisories/new)).

Expect an acknowledgement within a few days.

## What this software can do

Be aware of the trust model before reporting, and before using it:

- The bridge listens on `127.0.0.1` only, but **any process on your machine can
  reach that port**. It is the same class of exposure as a token in your home
  directory. This is a known, documented boundary rather than a vulnerability.
- The extension holds `chrome.debugger` over your daily browser. That is a
  powerful capability by design.
- `chrome_evaluate` runs arbitrary JavaScript in a granted page, and
  `chrome_upload_file` hands local files to it. Both require an origin grant.
- **Page content is untrusted input.** Snapshots, page text, and screenshots go
  to a model, so a hostile page can attempt prompt injection. Grant origins you
  trust; there is no second classifier here.

Reports that are especially welcome: a way to act on an origin without a grant,
to reach a blocked origin (`chrome://`, the Web Store, other extensions), to
escape the localhost binding, or to make the extension act on a page the server
never asked about.

## Supported versions

The latest release. This is a young project; fixes land on `main`.
