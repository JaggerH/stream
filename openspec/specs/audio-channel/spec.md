## Purpose

音频作为一等的流角色：独立的音乐视图与路由、连续队列播放、喜欢歌单及其归档优先播放。

## Requirements

### Requirement: Audio flow role
The system SHALL provide a flow role `audio`, parallel to `timeline` and `search`.
An `audio` binding SHALL reuse the timeline binding fields (cadence_seconds,
vault_subdir, ordering) and SHALL be fetched by the scheduler on its cadence
exactly like a timeline binding. No database migration SHALL be required.

#### Scenario: Promote a source to the audio role
- **WHEN** a source is promoted to role `audio` with a cadence
- **THEN** an `audio` binding is created with the given cadence/vault_subdir/ordering
- **AND** the API accepts `audio` as a valid role (no "role must be search|timeline|discover" error)

#### Scenario: Scheduler fetches audio streams
- **WHEN** the scheduler runs its tick cycle
- **THEN** streams reconstructed from `audio` bindings are fetched and their items written, the same as timeline streams

### Requirement: Audio routing isolation
Items belonging to an `audio` stream SHALL appear only in the 歌单 (music) view
and SHALL NOT appear in the Timeline view, the 全部 view, or any other non-music
view. A stream's kind SHALL be exposed via `/api/streams` as `timeline` or `audio`.

#### Scenario: Audio items excluded from timeline
- **WHEN** the Timeline (or 全部) view is rendered
- **THEN** items from `audio` streams are not present in the list

#### Scenario: Audio items shown in music view
- **WHEN** the 歌单 view selects an audio stream
- **THEN** that stream's items (tracks) are listed

#### Scenario: Stream kind exposed
- **WHEN** the frontend requests `/api/streams`
- **THEN** each stream includes `kind` of `timeline` or `audio`

### Requirement: Top-level music view and entry
The system SHALL present a top-level 歌单 view as a parallel entry in the thumb
sidebar (Timeline is retained). Selecting it SHALL render a dedicated music
component: a left list of audio streams (playlists/stations) and, for the selected
stream, its tracks plus a 播放全部 control. The view is play-only in v1 (no
transcribe/parse card actions).

#### Scenario: Music entry parallel to timeline
- **WHEN** the thumb sidebar is rendered
- **THEN** a 歌单 entry appears alongside Timeline / Discovery / 资源搜索 / 广告
- **AND** the Timeline entry is still present

#### Scenario: Browse a playlist and play all
- **WHEN** the user selects an audio stream in the 歌单 view and triggers 播放全部
- **THEN** the stream's tracks become the play queue and the first track starts

### Requirement: Continuous queue playback
The global audio stage SHALL maintain a play queue (a track list and a current
index). When a track ends, the stage SHALL auto-advance to the next track in the
queue and stop when the queue is exhausted (no loop in v1). Playback SHALL
continue across scroll and view/channel switches.

#### Scenario: Auto-advance to next track
- **WHEN** the current track ends and a next track exists in the queue
- **THEN** the next track loads and plays automatically

#### Scenario: Stop at end of queue
- **WHEN** the last track in the queue ends
- **THEN** playback stops and no further track loads

### Requirement: Add-source 歌单 destination
The add-source role picker SHALL offer a third destination 歌单 (audio), available
for timeline-capable sources, reusing the cadence selector. Promoting through it
SHALL create an `audio` binding. The channels-management page SHALL list audio
bindings in a 歌单 section.

#### Scenario: Add a source as 歌单
- **WHEN** the user picks a timeline-capable source and selects the 歌单 role with a cadence
- **THEN** an `audio` binding is created and the source appears in the 歌单 view

#### Scenario: Channels management shows audio section
- **WHEN** the channels-management page is rendered
- **THEN** audio bindings are listed under a 歌单 section

### Requirement: Built-in liked songs playlist
The system SHALL provide a built-in music playlist named `我喜欢的歌曲` that is owned by Stream rather than an external source. It SHALL appear before external audio streams in the music playlist grid. Opening it SHALL render the same track table used by normal music playlists.

#### Scenario: Open liked songs playlist
- **WHEN** the user opens the music view
- **THEN** a `我喜欢的歌曲` playlist entry appears before external playlists
- **WHEN** the user opens `我喜欢的歌曲`
- **THEN** liked tracks render in the shared music track table

### Requirement: Persistent liked song toggles
The system SHALL persist liked song state by `(platform, track_id)`. The heart control in music search results, external playlist rows, and liked playlist rows SHALL toggle the same persistent record.

#### Scenario: Like a searchable song
- **WHEN** the user likes a search result with platform and track id
- **THEN** the backend stores the track identity and display snapshot
- **AND** the song appears in `我喜欢的歌曲`

#### Scenario: Unlike a liked song
- **WHEN** the user unlikes a track from any music table
- **THEN** the backend removes that liked track
- **AND** the song is removed from `我喜欢的歌曲`

### Requirement: Archive-first playback for liked songs
Liked songs SHALL store track references, not audio files. Playing a liked song SHALL use the existing `/api/audio/resolve` path so local archive playback is preferred and online resolution is used as fallback.

#### Scenario: Play a liked song
- **WHEN** the user plays a track from `我喜欢的歌曲`
- **THEN** the player requests `/api/audio/resolve` with the liked track platform and id
- **AND** the resolver serves a local archive if present or an online stream otherwise
