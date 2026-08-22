# A contract pin

- Commit: `9507390cb65d9be27522bb02d7ae2e4cf0993c7b`
- Rebuilt contracts tgz SHA-256: `1400f659eb3ad88624b716ebe7f484619c06240133b065df079c68d7d06eb8f0`

The integration branch consumes `@sciforge/collaboration-contracts@0.2.0` from
the merged A/R0 contract layer. The archive hash is reproducible by checking out
the pinned commit, running the package build, and packing that package with npm
10.9.4 on Node.js 22.22.1. The published Task proposal digest helper is the only
implementation B uses for immutable `tasks.create` confirmation binding.
