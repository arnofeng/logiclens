# Java schema benchmark

This is an explicit trend tool, separate from the offline correctness suite. The manifest pins the Spring repository, commit, archive digest, adapter limits, and approved baseline version. It never follows a branch or updates its own manifest/baseline.

Use an already extracted checkout with `pnpm benchmark:java-schema -- --fixture <path>`, an existing archive with `--archive <file>`, or explicitly allow the pinned download with `--archive <file> --download`. Downloads are SHA-256 verified before extraction. A normal run performs one warm-up and five measured clean-full indexes and reports medians. Every warm-up/sample runs in a fresh child process; the parent samples that process's RSS every 20 ms and records the observed peak, so retained state cannot contaminate later samples. `--smoke` is the offline one-sample CI/OOM guard and is not a performance gate.
