## Purpose

项目自带一份写插件的 skill：怎么申报分组、实现要过哪张清单。

## Requirements

### Requirement: Project provides create_plugin skill
The repository SHALL provide a project-local `create_plugin` skill for authoring Stream plugins according to the architecture and current descriptor contracts.

#### Scenario: Skill exists locally
- **WHEN** a developer asks to create or scaffold a Stream plugin
- **THEN** Codex can use the project-local `create_plugin` skill
- **AND** the skill references the repository's authoritative plugin architecture and plugin guide

### Requirement: Skill documents grouping declarations
The `create_plugin` skill SHALL teach plugin authors how to declare source grouping and choose resolver call points.

#### Scenario: Skill recommends manifest facility for generic grouping
- **WHEN** a plugin's groups are known in source manifests
- **THEN** the skill instructs the author to declare `sourceGrouping.resolver: manifest.facility`
- **AND** each grouped source includes a `facility` key and label

#### Scenario: Skill explains plugin-specific resolver call points
- **WHEN** a plugin needs custom grouping logic
- **THEN** the skill instructs the author to expose a resolver through `adapter.<function>` or `plugin.<function>`
- **AND** the skill avoids recommending global plugin-specific resolver names

### Requirement: Skill covers plugin implementation checklist
The `create_plugin` skill SHALL cover descriptor fields, source manifest fields, backend declaration, credential declaration, presenter registration, grouping resolver tests, and API catalog tests.

#### Scenario: Developer follows skill checklist
- **WHEN** a developer scaffolds a new plugin using the skill
- **THEN** the resulting work includes plugin descriptor metadata, source manifests, optional backend config, credential declarations, presenter guidance, grouping configuration when applicable, and a test checklist
