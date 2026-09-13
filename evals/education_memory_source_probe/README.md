# Native source-reader post-hoc mechanism probe

Read PROTOCOL.md first. This folder is a new supplemental probe, not a replacement of Formal03. Data are fixed 24 synthetic self-reports (8 computing topics × 3 positions); real native events form all Fact rows.

Use an existing Web environment and the final integration core. No dependency installation or model is requested:

```bash
/Users/a1-6/LearnFlow/backend/venv/bin/python run.py prepare --repo /tmp/learnflow-memory-upgrade-20260913 --output /tmp/learnflow-native-source-probe-01
/Users/a1-6/LearnFlow/backend/venv/bin/python run.py execute --output /tmp/learnflow-native-source-probe-01
```

Prepare freezes protocol, data, driver/verifier and product source hashes before execution. Outputs retain all 96 packets or explicit error rows, formation snapshots, independently checked candidates, metrics and report. SQLite databases are in-memory only. Source labels never enter the reader query. No source file or result is tuned after observing probe performance; fixes require a disclosed new run.
