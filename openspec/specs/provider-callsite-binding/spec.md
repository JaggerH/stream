## Purpose

代码申报 Provider 的调用点契约，持久化的绑定在其中选出兼容的 Provider；引用可观测、删除安全，默认绑定可恢复。

## Requirements

### Requirement: Code declares Provider callsite contracts
The system SHALL register every dynamically configurable Provider callsite in code with a stable id, label,
description, compatible Provider variant, resolution mode, and default Provider references.

#### Scenario: Descriptor exposes a video metadata contract
- **WHEN** a client reads the registered Provider callsites
- **THEN** it receives the `video.detail.metadata` fixed callsite and its compatible `metadata` variant

### Requirement: Persisted bindings select compatible Providers
The system SHALL persist a binding for each configured callsite and SHALL reject unknown callsites, duplicate
Provider references, incompatible Provider variants, an empty dispatch binding, or a fixed binding that does
not contain exactly one Provider.

#### Scenario: Bind a replacement metadata Provider
- **WHEN** a client writes `my-metadata` to the fixed `video.detail.metadata` binding and the Provider has the `metadata` variant
- **THEN** the binding is stored and subsequent metadata lookup resolves `my-metadata`

### Requirement: Dispatch bindings scope key routing
The system SHALL resolve a dispatch callsite only among the ordered Provider references in its binding, using
an exact `serves` key before a `*` fallback.

#### Scenario: Specific Provider beats fallback inside a binding
- **WHEN** a dispatch binding contains an exact `bilibili.com` Provider before a `*` fallback and the callsite supplies `bilibili.com`
- **THEN** the exact Provider is selected

### Requirement: Provider references are observable and deletion-safe
The system SHALL expose both callsite-to-Provider bindings and Provider-to-callsite references, AND SHALL treat
a Provider referenced as another Provider's `{provider}` member as a deletion blocker of the same kind. It SHALL
reject deletion of a Provider with a conflict response while any binding OR any `{provider}` member reference
targets that Provider.

#### Scenario: Deletion reports binding blockers
- **WHEN** a client deletes a Provider bound to `video.detail.metadata`
- **THEN** the API returns a conflict containing `video.detail.metadata` and retains the Provider

#### Scenario: Deletion reports member-reference blockers
- **WHEN** a client deletes a Provider that is referenced as a `{provider}` member of another Provider
- **THEN** the API returns a conflict identifying the referencing Provider and retains the deleted target

#### Scenario: Deletion succeeds after replacement
- **WHEN** every binding AND every `{provider}` member reference targeting a Provider is replaced or removed
- **THEN** deleting that Provider succeeds regardless of whether it originated from a builtin default

### Requirement: Default Provider bindings are recoverable
The system SHALL provision missing default bindings without overwriting existing user bindings and SHALL offer
an explicit operation to restore a callsite binding to its builtin default.

#### Scenario: Upgrade preserves a user binding
- **WHEN** bootstrap runs after a user bound `video.detail.metadata` to a replacement Provider
- **THEN** bootstrap retains the replacement binding
