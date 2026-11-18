## ADDED Requirements

### Requirement: stale-ref errors carry a structured kind receipt

A device error frame with `code: "stale-ref"` MAY carry `semantics: {kind, ref}`, where `kind` is
one of `snapshot_unknown`, `ref_not_in_snapshot`, `ref_retired`, `element_moved`. The backend
SHALL forward it verbatim on `HostOpError.semantics` and in the management routes' 502 body, like
the other semantics shapes, without interpreting it.

#### Scenario: an embedder reads the kind
- **WHEN** the phone answers `{error: "stale-ref: r7 …", code: "stale-ref", semantics: {kind: "element_moved", ref: "r7"}}`
- **THEN** `HostOpError.semantics` carries `{kind: "element_moved", ref: "r7"}` and the 502 body
  carries the same object
