## ADDED Requirements

### Requirement: Devices declare a capability manifest that embedders can read

A device agent MAY send, in its `hello`, a capability manifest: `capsVersion` (the manifest schema
version, a positive integer; absent means 1) and `caps`, an object mapping a capability id to
`{v, availability?}`. `v` SHALL be a positive integer; `availability`, when present, SHALL be one of
`always`, `foreground`, `push` (absent means `always`). Capability ids are lowercase dot-separated
words; the vocabulary is open and the backend SHALL keep ids it does not know.

The backend SHALL parse the manifest at handshake and keep it with the live device. Under a schema
version it knows, a malformed manifest (not an object, a bad id, a non-positive-integer `v`, an
availability outside the set, more than 64 entries) SHALL refuse the whole `hello`, the same as a
malformed `ops`. Under a schema version it does not know, the device SHALL connect and its manifest
SHALL be ignored. A `hello` without `caps` SHALL connect as before.

The device-online change (`devices.onChange`, kind `device`) and the `devices.online()` snapshot
SHALL carry `caps` next to `ops` when the device declared a manifest, and SHALL omit the field when it
did not. Offline changes carry neither. `GET /api/devices` rows for online devices SHALL carry `caps`
under the same rule.

#### Scenario: an old device without a manifest

- **WHEN** a device sends a `hello` with `ops` and no `caps`
- **THEN** it connects, and its online change and snapshot entry carry `ops` and no `caps` field

#### Scenario: a manifest surfaces on reconnect

- **WHEN** the same device reconnects with `capsVersion: 1` and `caps: {"ui.tree": {"v": 1}, "notify.post": {"v": 1, "availability": "push"}}`
- **THEN** the online change and the snapshot carry that `caps` object verbatim

#### Scenario: an unknown schema version

- **WHEN** a device sends `capsVersion: 2` with a manifest shaped differently
- **THEN** it connects and no `caps` is surfaced for it

#### Scenario: a malformed manifest

- **WHEN** a device sends `caps: {"ui.tree": {"v": 0}}`
- **THEN** the hello is refused like any other malformed hello
