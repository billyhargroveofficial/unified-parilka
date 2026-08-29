# OpenClaw projection

Writes committed Dream, fast notes, lessons and skills into the OpenClaw
agent workspace (`MEMORY.md` at the workspace root and
`skills/parilka-managed/`). Reuses the Hermes snapshot/render/skill writers;
the memory file path differs (`MEMORY.md`, not `memories/MEMORY.md`).

Enable with `PARILKA_OPENCLAW_PROJECTION_ENABLED=true`. CLI:
`bin/parilka-openclaw-project --apply --workspace <dir>`.
