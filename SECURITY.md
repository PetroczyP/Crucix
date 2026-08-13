# Security Policy

## Reporting a Vulnerability

If you discover a security issue in Crucix, please report it privately instead of opening a public GitHub issue.

Use GitHub's [private vulnerability reporting](https://github.com/PetroczyP/Crucix/security/advisories/new) — open the repository's **Security** tab and choose *Report a vulnerability*. The report stays private between you and the maintainers.

Please include:

- affected component or file
- steps to reproduce
- impact
- proof of concept if available
- any suggested remediation

## Response Expectations

Best-effort targets:

- acknowledgement within 72 hours
- initial triage within 7 days
- coordinated disclosure after a fix is available

## Scope

The highest-priority reports are:

- XSS or HTML/script injection in the dashboard
- unsafe rendering of mixed-source external content
- authentication or secret-handling issues
- server-side injection or path traversal
- dependency or supply-chain issues with real exploit impact

## Out of Scope

The following are generally lower priority unless they create a concrete exploit path:

- minor UI bugs
- missing best-practice headers without impact
- rate limiting or reliability issues without a security consequence

## Public Disclosure

Please do not disclose the issue publicly until a fix is shipped or we agree on a disclosure timeline.
