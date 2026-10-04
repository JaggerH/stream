## Purpose

把广告从收件箱里折叠掉：确定性的条目级分类规则、阅读期人工标注、精度守门的规则建议，以及夹具驱动的回归闸。

## Requirements

### Requirement: Deterministic item-level ad classification

The system SHALL classify an item as an ad by matching configured keyword and domain rules against the item's title, body text, source category tags, and URLs. A match SHALL set a `muted` flag carrying the matched rule; it MUST NOT alter any other field of the item (fold, not delete).

#### Scenario: Keyword in title

- **WHEN** an item's title contains a configured keyword
- **THEN** the item is muted with `reason: 'ad'` and `rule` set to that keyword

#### Scenario: Keyword only in source category

- **WHEN** an item's title and body contain no keyword but its source category tag does (e.g. v2ex 推广 node)
- **THEN** the item is muted with the matched keyword as `rule`

#### Scenario: Classification is non-destructive

- **WHEN** the same raw item is converted with rules and without rules
- **THEN** the two results are identical except that the rule-applied result additionally carries `muted`

### Requirement: Runtime rule composition

The system SHALL ship canonical rules as committed code (`DEFAULT_AD_RULES`) and compose runtime rules as the union of `DEFAULT_AD_RULES` and the user's `config.yaml` `ad_filter`. Tests SHALL run against `DEFAULT_AD_RULES`.

#### Scenario: Defaults always apply

- **WHEN** `config.yaml` has no `ad_filter`
- **THEN** the runtime classifier still applies all `DEFAULT_AD_RULES`

#### Scenario: User config extends defaults

- **WHEN** `config.yaml` `ad_filter` adds a keyword not in defaults
- **THEN** the runtime classifier matches both the default rules and the user-added keyword

### Requirement: Reading-time manual labeling

The system SHALL let a user label an item as 广告, 抽奖, or 非广告 through an explicit action while reading it. Labeling MUST be a deliberate gesture, never a side effect of opening or selecting an item. A 广告/抽奖 label SHALL set `muted` with `manual: true` and the chosen `reason`; a 非广告 label SHALL clear `muted`.

#### Scenario: Label as lottery

- **WHEN** the user selects 抽奖 on an item
- **THEN** the item's `muted` becomes `{ reason: 'lottery', manual: true, ... }` and the item moves into the 广告 channel

#### Scenario: Label as not-ad clears a false positive

- **WHEN** the user selects 非广告 on a currently-muted item
- **THEN** the item's `muted` is cleared and the item leaves the 广告 channel

#### Scenario: Opening does not label

- **WHEN** the user opens an item to read it without using the label control
- **THEN** the item's `muted` state is unchanged

### Requirement: Golden corpus generation

The system SHALL provide a command that turns labeled items into committed fixture files, one JSON per item keyed by item id. A fixture SHALL store the fields the classifier consumes plus the label (`positive`/`negative`) and `reason`. The command SHALL treat an item as unprocessed when no fixture file exists for its id, making the fixtures directory itself the processed set (idempotent, overwrite-safe).

#### Scenario: Unprocessed labeled item becomes a fixture

- **WHEN** the generation command runs and a muted item has no existing fixture file
- **THEN** a positive fixture JSON is written for that item id

#### Scenario: Already-processed item is skipped

- **WHEN** the generation command runs and a fixture file already exists for an item id
- **THEN** that item is not regenerated

### Requirement: Precision-guarded rule suggestion

For each red-light positive fixture (one the current rules fail to match), the system SHALL propose candidate rules — registrable domains from the item URLs and keywords from category tags and a promotional lexicon — ranked category > domain > token. A candidate SHALL be rejected if adding it would cause any negative fixture to be muted. Candidates SHALL only be printed for human review and MUST NOT be auto-committed to the rule set.

#### Scenario: Suggest a rule for a missed ad

- **WHEN** a positive fixture is not matched by current rules
- **THEN** the command prints candidate rules that would match it

#### Scenario: Reject a candidate that would cause a false positive

- **WHEN** a candidate rule would also mute a known negative fixture
- **THEN** that candidate is excluded from the suggestions

### Requirement: Fixture-driven regression gate

The test suite SHALL assert, for every fixture, that the classifier's verdict matches the label: every positive fixture MUST be muted and every negative fixture MUST NOT be muted. A failing assertion is the signal to add (positive) or tighten (negative) a rule.

#### Scenario: Positive fixture must be caught

- **WHEN** the regression test runs over a positive fixture
- **THEN** it fails unless `classifyAd` mutes that fixture's fields

#### Scenario: Negative fixture guards precision

- **WHEN** the regression test runs over a negative fixture (e.g. a news item that merely mentions advertising)
- **THEN** it fails if `classifyAd` mutes it
