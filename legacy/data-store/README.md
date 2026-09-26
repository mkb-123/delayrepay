# Legacy data store

This directory contains data produced by the original TypeScript implementation:

- `archive.json`: its combined service and assessment archive
- `brief-2026-09-25.md`: its generated briefing
- `runs.jsonl`: its ingestion attempt log
- `observations/`: raw RTT responses retained by that collector

The active Python application writes its catalogue, normalized daily records, reports, and claim acknowledgements to the root `data-store/` directory. Cache-only discovery can still read the archived observations when explicitly requested with `discover --from-cache`.
