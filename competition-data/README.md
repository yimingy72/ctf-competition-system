# Competition traces

This directory records the provenance of the R11 and R12 Cyber Arena
competition traces published as GitHub Release assets.

## Release

- Release tag: `competition-traces-r11-r12`
- R11 asset: `attempt-archive-r11-01a1ff8b.ndjson.zst`
- R12 asset: `attempt-archive-r12-01a201e3.ndjson.zst`

The GitHub repository does not store these files in ordinary Git history
because both archives exceed GitHub's 100 MB per-file limit. The Release
assets preserve the complete NDJSON trajectory streams.

## Rounds

| Round | Attempt ID | Started | Finished | Challenges | Completed | Canceled |
| --- | --- | --- | --- | ---: | ---: | ---: |
| R11 | `01a1ff8b-5c34-74a6-85b9-0bbd43932344` | 2026-11-22 03:18:05 +08:00 | 2026-11-22 05:52:03 +08:00 | 20 | 19 | 1 |
| R12 | `01a201e3-e2f2-71a2-8a76-9ba54907d475` | 2026-11-22 14:14:01 +08:00 | 2026-11-22 17:58:39 +08:00 | 20 | 18 | 2 |

Both rounds used the same competition:
`01a1fd2a-91cb-7b42-8146-1be766b4ed8f`.

## Sanitization

The source exports reported `redactionPolicy: none`. Before publishing, the
archives were stream-sanitized so public readers cannot reuse runtime
credentials. Bearer values, Arena solver tokens, API keys, PATs, and GitHub
tokens use `[REDACTED]` markers. Messages, reasoning, tool calls, tool outputs,
board state, challenge results, and timestamps are otherwise preserved.

The exact source files remain unchanged in the local Downloads directory.

## Verification

The two release assets are listed in `manifest.json` with their byte sizes,
SHA-256 digests, run counts, and sanitization policy. To verify an asset:

```bash
shasum -a 256 attempt-archive-r11-01a1ff8b.ndjson.zst
shasum -a 256 attempt-archive-r12-01a201e3.ndjson.zst
zstd -t attempt-archive-r11-01a1ff8b.ndjson.zst
zstd -t attempt-archive-r12-01a201e3.ndjson.zst
```
