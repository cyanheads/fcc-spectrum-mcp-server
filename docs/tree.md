# fcc-spectrum-mcp-server - Directory Structure

Generated on: 2026-10-01 02:45:28

```text
fcc-spectrum-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build-state-boundaries.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── fcc-mirror-init.ts
│   ├── fcc-mirror-refresh.ts
│   ├── fcc-mirror-verify.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       └── license.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── find-transmitters.tool.ts
│   │       │   ├── get-license.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── list-reference.tool.ts
│   │       │   ├── search-frequencies.tool.ts
│   │       │   └── search-licenses.tool.ts
│   │       ├── format-helpers.ts
│   │       └── input-schemas.ts
│   ├── services/
│   │   └── uls/
│   │       ├── data/
│   │       │   └── us-states.json
│   │       ├── bulk-client.ts
│   │       ├── codes.ts
│   │       ├── dat.ts
│   │       ├── ingest-schedule.ts
│   │       ├── ingest.ts
│   │       ├── normalize.ts
│   │       ├── schema.ts
│   │       ├── state-lookup.ts
│   │       ├── types.ts
│   │       ├── uls-index-service.ts
│   │       └── zip-reader.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── tool-harness.ts
│   │   ├── uls-fixtures.ts
│   │   └── uls-index.ts
│   ├── resources/
│   │   └── license.resource.test.ts
│   ├── services/
│   │   └── uls/
│   │       ├── bulk-client.test.ts
│   │       ├── codes.test.ts
│   │       ├── dat.test.ts
│   │       ├── ingest-schedule.test.ts
│   │       ├── ingest.test.ts
│   │       ├── normalize.test.ts
│   │       ├── schema.test.ts
│   │       ├── state-lookup.test.ts
│   │       ├── uls-index-service.test.ts
│   │       └── zip-reader.test.ts
│   ├── smoke/
│   │   └── definitions.smoke.test.ts
│   ├── tools/
│   │   ├── find-transmitters.tool.test.ts
│   │   ├── format-helpers.test.ts
│   │   ├── get-license.tool.test.ts
│   │   ├── input-schemas.test.ts
│   │   ├── list-reference.tool.test.ts
│   │   ├── search-frequencies.tool.test.ts
│   │   └── search-licenses.tool.test.ts
│   └── index.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
