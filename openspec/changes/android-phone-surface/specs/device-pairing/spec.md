## ADDED Requirements

### Requirement: Phones pair with a one-time code and get their own token

The backend SHALL mint pairing codes (6 digits, 5-minute TTL, single use) only for requests from
the local machine. Pairing with a valid code SHALL return a new `android:<uuid>` device id and a
256-bit device token, of which only a hash is stored. Five failed attempts SHALL invalidate every
outstanding code. The pair route SHALL NOT require the API access token.

#### Scenario: a code from another machine is refused
- **WHEN** a non-loopback client requests a pairing code
- **THEN** the backend answers 403 and mints nothing

#### Scenario: a code pairs once
- **WHEN** a phone pairs with a valid code, and then a second phone tries the same code
- **THEN** the first receives a device id and token, and the second is refused with `invalid-code`

### Requirement: Device tokens are bound to their device

`/api/host` SHALL accept a device token in place of the shared secret. A connection authorized by
a device token whose `hello.deviceId` differs from the bound id SHALL be closed with 4003.
Revoking a device SHALL forget its token and close its live connection with 4003.

#### Scenario: a revoked phone is dropped at once
- **WHEN** the user revokes a connected phone in the panel
- **THEN** its socket closes with 4003 and its token no longer authorizes an upgrade
