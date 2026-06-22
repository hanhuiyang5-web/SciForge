# SciForge plug-in services

Standalone, **plug-and-play** translation services. Each is an independent, dependency-free
TypeScript HTTP server with its own `package.json` (an npm workspace). They are **not** bundled
into or imported by the desktop app — the Model Router talks to them over HTTP and works fine
when they are absent (fail-open). Run them where the heavy models live (a GPU box, or locally),
and point the Model Router process at them with an env var.

| Plug-in | Port | Endpoint | Translates | Upstream model(s) |
|---|---|---|---|---|
| [`vision-router-service`](./vision-router-service) | 3899 | `POST /vision/translate` | image / video frame → text | Qwen3.7-Plus (cloud, OpenAI-compatible) |
| [`sci-modality-router-service`](./sci-modality-router-service) | 3898 | `POST /modality/translate`, `GET /experts/status` | 6 scientific modalities → text evidence | expert-translator (GPU): ESM-2, Nucleotide-Transformer, ChemLLM, SciBERT×2, ChemBERTa |
| [`ppt-master-mcp-service`](./ppt-master-mcp-service) | stdio | MCP tools | SciForge research context → ppt-master project/export stages | local `~/.codex/skills/ppt-master` scripts |

Both follow the same contract: **translate-only** (return evidence/`ServiceResult`, never a final
answer), auto-detect input, own their own retry/robustness, and redact secrets from traces.

## How the app uses them

- **Vision**: the model router translates image inputs via its `translators.vision` provider
  (Qwen). The `vision-router-service` packages that same translate-only behavior as a standalone
  service for reuse outside the router.
- **Scientific**: gated inside Model Router by `SCIFORGE_SCIMODALITY_SERVICE_URL`. GUI/Kun/Codex
  pass workspace-local `input_object` refs; only Model Router reads explicit scientific files and
  calls `sci-modality-router-service` (which calls the GPU expert-translator). When unset or
  unreachable, Model Router falls back to readable raw file text where safe — no runtime-side
  service calls.
- **PPT master**: exposed as Agent-chosen MCP tools because it is an output workflow, not an input
  translator. It bundles SciForge papers, write drafts, quoted selections, and Model Router evidence
  into ppt-master sources, then runs only project/setup/check/export stages. Raw scientific modality
  files still stay in the Model Router evidence flow.

## Run a plug-in

```bash
npm --workspace sciforge-sci-modality-router-service run start   # :3898
npm --workspace sciforge-vision-router-service run start         # :3899
npm --workspace sciforge-ppt-master-mcp-service run start        # stdio MCP
npm --workspace sciforge-sci-modality-router-service test        # stubbed unit tests
npm --workspace sciforge-ppt-master-mcp-service test             # stubbed MCP/unit tests
```

The scientific expert models themselves (the GPU "provider" behind `sci-modality-router-service`)
are deployed separately on the GPU server — see the GPU deployment docs.
