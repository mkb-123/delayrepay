# Legacy Python JSON storage

These files were produced before the Python application moved its operational state to SQLite.

On first use, a new `data-store/delayrepay.sqlite` database imports the archived daily JSON automatically. After migration, collection, assessments, claim acknowledgements, and history queries use SQLite. Generated output is written to `data-store/output/latest.json` and `latest.md`.
