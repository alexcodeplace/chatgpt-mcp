# Dependency policy

This project pins pnpm 11.20.0 and commits `pnpm-lock.yaml`.

pnpm 11 defaults to a 24-hour `minimumReleaseAge`, so fresh dependency resolution intentionally avoids packages published within the previous day. The committed lockfile keeps normal installs deterministic instead of resolving a new transitive release during installation.

pnpm 11 also enables strict dependency-build handling. `pnpm-workspace.yaml` explicitly allows the required `esbuild` install script and does not broadly relax dependency-build policy.

Normal installation should use the committed lockfile. Dependency upgrades should regenerate and review the lockfile deliberately.
