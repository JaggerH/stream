## ADDED Requirements

### Requirement: Multi-device host relay

The `/api/host` relay SHALL speak `host-relay.v2`. The first frame of every connection SHALL be a
`hello` that declares `deviceId`, `platform` (`windows` | `macos` | `android`), `name`,
`agentVersion` and `ops`. The relay SHALL keep one session lease per device, so recipes on different
devices run concurrently and recipes on the same device serialize. A new connection SHALL replace
only the previous connection of the same `deviceId`.

#### Scenario: a phone connecting does not disconnect the PC
- **WHEN** a desktop agent is connected and an Android agent completes its hello
- **THEN** both devices are listed, and an op sent to the desktop device reaches only the desktop socket

#### Scenario: a connection without a hello is closed
- **WHEN** the first frame of a connection is not a valid hello, or none arrives within 5 seconds
- **THEN** the relay closes the socket with code 4001 and registers no device

#### Scenario: a v1 agent is refused by name
- **WHEN** an agent offers only `host-relay.v1`
- **THEN** the upgrade is answered with HTTP 426 and a body saying Stream Desktop is too old

### Requirement: Declared op sets decide capability

The desktop driver SHALL decide whether a device supports an op from the device's declared `ops`,
before sending. A read op the device does not declare (`readText`, `readElements`, `findImage`)
SHALL return `null`, `nudge` SHALL return `false`, and `status` SHALL be a no-op. Any other
undeclared op SHALL fail with `UnsupportedOpError` without being sent. An error returned by the
agent for a declared op SHALL propagate unchanged.

#### Scenario: an undeclared action fails before the wire
- **WHEN** a recipe step clicks on a device whose hello did not declare `click`
- **THEN** the step fails with `unsupported-op: click` and nothing is sent to the device
