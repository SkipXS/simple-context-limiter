# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Documented that public-only fetch checks and private-host cache bypass are best-effort convenience guards, not an SSRF sandbox or substitute for external network isolation.
- Trimmed published package contents to runtime files and docs, made source-checkout npm validation scripts safe in installed packages, and made pack smoke validation assert the tarball file list plus installed script/bin behavior.

## 1.1.0 - 2026-06-13

- Hardened `sc-fetch` cache defaults for private/local URLs, added explicit cache controls, rejected binary responses, and documented charset behavior.
- Added server backpressure for queued tool calls and pending JSON-RPC request lines.
- Fixed `sc-read` range byte caps and empty-range metadata.
- Made `sc-diff` preview generation more bounded for changed-file discovery, hunk output, and large single hunks.
- Improved CI/package validation to avoid duplicate smoke/unit execution while preserving `npm run check`, `npm test`, and release checks.
- Updated package smoke validation to execute the installed package bin entrypoint.
- Added regression tests plus minimal contributing and security policy documentation.
- Expanded README guidance for reproducible client configuration, privacy, cache behavior, and local storage opt-outs.

## 1.0.0

- Initial public package metadata and MCP server tooling baseline.
