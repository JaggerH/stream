## Purpose

一个 Provider 可以是另一个 Provider 的成员：组合带环与深度守卫，expand 策略从一个成员扇出到另一个再把结果装配起来。

## Requirements

### Requirement: A Provider can be a member of another Provider
The system SHALL allow a Provider member to be a reference to another Provider (`{provider: id}`), resolved by
recursively invoking that Provider rather than reading a leaf Source. The child Provider's items-type result
SHALL be merged into the parent's member results as an opaque contribution — the child's own strategy, gate,
and dedup remain internal and are not flattened into the parent.

#### Scenario: Composed member's items merge into the parent
- **WHEN** a Provider declares a `{provider: X}` member and is invoked
- **THEN** Provider X is invoked recursively and its items-type result is merged into the parent result, with the parent's dedup and gate applied unchanged

#### Scenario: Composed member decline contributes nothing
- **WHEN** the referenced child Provider returns an empty items result (decline)
- **THEN** that member contributes no items and does not fail the parent invocation

### Requirement: Provider composition is guarded against cycles and unbounded depth
The system SHALL carry a visited path of Provider ids through recursive member resolution and SHALL reject a
member reference whose id already appears on the path (self-reference or cycle), and SHALL reject resolution
that exceeds a fixed maximum composition depth.

#### Scenario: Self-reference is rejected
- **WHEN** a Provider declares a `{provider}` member pointing at itself
- **THEN** resolution is rejected with a cycle error and no invocation loop occurs

#### Scenario: A composition cycle is rejected
- **WHEN** Provider A references Provider B as a member and B references A
- **THEN** resolving either is rejected with a cycle error

#### Scenario: Over-depth composition is rejected
- **WHEN** a chain of `{provider}` members exceeds the maximum composition depth
- **THEN** resolution is rejected with a depth error rather than recursing indefinitely

### Requirement: The expand strategy fans out from one member to another and assembles the results
The system SHALL support a Provider/Stream `strategy: expand` over exactly two ordered members [A, B]. It SHALL
invoke A to obtain handle items, map each handle to B's params using a declared mapping that reads ONLY the
A-item's own fields, invoke B per handle, and assemble B's items into that handle's result as its `links[]`.
Fan-out SHALL be bounded (a handle cap and bounded concurrency); a single B invocation that fails or times out
SHALL be skipped without failing the whole strategy.

#### Scenario: Each handle drives B and B items become that handle's links
- **WHEN** an expand strategy runs over [A, B] and A yields N handle items
- **THEN** B is invoked once per handle (up to the cap) and each result item carries B's items as its `links[]` alongside the A-item's own fields

#### Scenario: The handle-to-B mapping reads only A-item fields
- **WHEN** the expand mapping constructs B's params
- **THEN** it derives values solely from the A-item's declared fields and cannot invoke ambient capability

#### Scenario: A single failed drill is skipped, not fatal
- **WHEN** B fails or times out for one handle
- **THEN** that handle produces no result and the remaining handles still return

#### Scenario: Handle count is capped
- **WHEN** A yields more handles than the configured cap
- **THEN** only up to the cap are expanded
