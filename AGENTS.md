# For AI assistants

Read [skills/wwm-guild-manager/SKILL.md](skills/wwm-guild-manager/SKILL.md) first.

- Installing, updating or fixing a server → [operations](skills/wwm-guild-manager/references/operations.md)
- Changing the code → [architecture](skills/wwm-guild-manager/references/architecture.md),
  then [features](skills/wwm-guild-manager/references/features.md),
  [design](skills/wwm-guild-manager/references/design.md) and
  [API](skills/wwm-guild-manager/references/api.md) as needed

Before shipping any code change: `npm test`, `npx tsc --noEmit` and `npm run build` must pass.
