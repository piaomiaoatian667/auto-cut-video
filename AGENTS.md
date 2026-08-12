# Agent Video Workspace Rules

- Never modify files under `projects/*/assets/source`.
- Treat `project.json`, `script.json`, and `edit.json` as editable sources of truth.
- Treat manifests, compiled timelines, run reports, and media outputs as generated files.
- Use integer frames for timeline positions and milliseconds for source trims.
- Never interpolate project data into shell command strings.
- Run the relevant validator after every project edit.
- Render and approve a draft before Release.
- Never bypass schema, path, decode, or release verification failures.
- Keep render-time fonts and media local; do not fetch network resources.
