# Security policy

Report security issues privately through the GitHub Security tab for this repository.
Do not open a public issue for a suspected vulnerability.

This bridge exposes only content returned by the configured public CMS API. Keep API
tokens read-only, bind the Node process to loopback behind a same-origin reverse proxy,
and review the publication rules in `DEPLOYMENT.md` before production use.
