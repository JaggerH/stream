## Purpose

当用户要的源在目录里搜不到时，把这个「发现缺口」交给用户自己的 code agent：提供把一个站点
接进来所需的技能文档，以及搜索落空时指向它的入口提示。

产出物是 **recipe**（住在用户自己的 `<dataDir>/recipes`，随 Channel/Stream 分享包走），
不是 RSSHub 路由——路由住在 Stream 管辖外的仓库里，分享出去在对方那边是个悬空 id，而且要等
上游合并才存在。`acquisition-routing` 把这条写死成「Tier 2 SHALL NOT route to an
external-repository contribution path」，本 spec 与它对齐。

## Requirements

### Requirement: Discovery gap prompt

When a user searches for a source that returns zero results, the system MAY surface a discovery-gap prompt; when it does, that prompt SHALL point at the user's own code agent adding the source, not at a manual workaround.

#### Scenario: Search miss triggers suggestion

- **WHEN** a user searches for a source and the search returns zero results
- **THEN** the UI MAY display a hint pointing at the user's own code agent adding the source

### Requirement: Source onboarding skill

The system SHALL provide skill documents that teach a user's code agent how to bring a new site in, and those documents SHALL produce a recipe that works locally without any upstream merge.

#### Scenario: Agent follows the skill to add a source

- **WHEN** a user's code agent reads the source-onboarding skills
- **THEN** the agent can analyze the target site, produce a conforming recipe, and the source is usable in this Stream install immediately

#### Scenario: Source travels with a shared bundle

- **WHEN** the user shares a Channel or Stream that references a source they authored
- **THEN** the recipe travels inside the shared bundle, so the recipient resolves the source without depending on any upstream repository

### Requirement: Existing RSSHub catalog stays readable

The system SHALL keep consuming the installed RSSHub catalog as a read-only source directory. Migrating an existing route to a recipe is opportunistic — done when that route needs repair, not as a bulk migration.

#### Scenario: Catalog sources keep working

- **WHEN** Stream loads the RSSHub catalog from installed npm packages
- **THEN** those sources remain searchable and subscribable, unchanged

> Contributing a route to RSSHub upstream remains something a user may do as a community
> contribution. What is retired is Stream *steering an agent* down that path as the product
> answer to "this source is missing".
