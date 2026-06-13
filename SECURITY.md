# Security Policy

## Supported Versions

This project currently supports the latest released version and the default branch until a broader release policy is established.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately by opening a GitHub security advisory or contacting the maintainers through the repository's security reporting channel. Avoid posting exploit details in public issues until a fix or mitigation is available.

Include the affected version or commit, operating system, Node.js version, reproduction steps, and any relevant MCP client configuration. We will acknowledge reports as quickly as practical and coordinate disclosure once the issue is understood.

## Security Model Reminder

simple-context-limiter is a local MCP server for trusted clients. It limits output size, but it does not sandbox commands, filesystem reads, git operations, or HTTP(S) fetches. `SIMPLE_CONTEXT_LIMITER_FETCH_PUBLIC_ONLY` and the default private-host fetch cache bypass are best-effort convenience guards only, not a security/SSRF sandbox. They perform preflight and redirect checks but do not pin DNS answers for the actual connection, so DNS rebinding and lookup-vs-connect TOCTOU remain possible. IPv6/RFC6890 special-use coverage is also not guaranteed to be complete enough to serve as a security boundary. Run it only for agents you trust, and use OS/container sandboxing, firewall/egress proxy policy, or equivalent external network controls when fetch isolation matters or when working with untrusted prompts or repositories.
