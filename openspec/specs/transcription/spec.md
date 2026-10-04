## Purpose

把音视频转成文字：与具体后端无关的 ASR 解析、按需取媒体、点击触发 + 按条目持久缓存、卡片上的入口，以及未配置时优雅降级。

## Requirements

### Requirement: Backend-agnostic ASR backend resolution
The system SHALL resolve an ASR backend's URL as `explicit → env <PLUGIN_ID>_URL → pluginGatewayUrl(pluginId)`, mirroring the existing video-service/pansou pattern, via a backend-agnostic client parameterized by plugin id (no per-backend client class). The resolved URL's host SHALL determine the reported mode: the local gateway loopback is `local`, any other host is `cloud`. Transcription SHALL be composed as a Provider whose members are the STT sources present in the install (e.g. `cf-whisper` cloud tier, `whisper-asr-local` local GPU fallback) — a backend not configured simply drops out as a member rather than being hardcoded.

#### Scenario: Local by default
- **WHEN** no explicit URL/env override is set and the `whisper-asr` plugin is configured
- **THEN** the backend resolves to the local gateway (`/_p/whisper-asr`) and the mode is `local`

#### Scenario: Cloud relay when configured
- **WHEN** `WHISPER_ASR_URL` (or the equivalent env override for the configured ASR plugin id) is set to a remote relay URL
- **THEN** the backend resolves to that URL and the mode is `cloud`

### Requirement: On-demand media resolution
The system SHALL resolve a video item's audio for transcription using existing proxies: bilibili via the audio-only stream (`/api/bili/audio`), and douyin/xhs via the video proxy mp4. Stream SHALL send the bytes to the ASR backend's `POST /transcribe`; the backend extracts the audio track. Items with no resolvable playable media SHALL NOT be transcribable.

#### Scenario: Bilibili uses audio-only
- **WHEN** a bilibili video item is transcribed
- **THEN** Stream fetches the smallest audio stream (not the 1080p video) and sends it to the ASR backend

#### Scenario: Douyin/xhs use the proxied mp4
- **WHEN** a douyin or xhs video item is transcribed
- **THEN** Stream sends the proxied mp4 bytes to the ASR backend, which extracts the audio

### Requirement: Click-triggered transcription with persistent per-item cache
Transcription SHALL run only on explicit request (never automatically). A result SHALL be persisted per item and reused: a second request for the same item SHALL return the cached transcript without re-invoking the backend. `POST /api/transcribe` SHALL start (or return the cached result of) a job; `GET /api/transcribe?item=<id>` SHALL return `running`, `done` (with text), or `error`.

#### Scenario: First transcription runs and caches
- **WHEN** an item with no cached transcript is transcribed
- **THEN** a job runs against the configured ASR backend and the resulting text is persisted keyed to the item

#### Scenario: Re-open is instant and free
- **WHEN** an item that already has a cached transcript is requested
- **THEN** the cached text is returned immediately and the backend is NOT invoked again

#### Scenario: Long job is polled
- **WHEN** transcription is still running
- **THEN** `GET /api/transcribe?item=<id>` returns status `running` and the caller polls until `done` or `error`

### Requirement: Transcribe affordance on video cards
A video item's card SHALL show a "转文字" action in its bottom action bar. Activating it SHALL trigger transcription and render the transcript in a reserved transcript panel on the card (collapsed until a transcript exists or is loading), showing a loading state while running.

#### Scenario: Button shown only for video posts
- **WHEN** a card represents a video item and at least one STT provider member (e.g. the `whisper-asr` plugin) is configured
- **THEN** a transcribe button appears in the card's bottom action bar

#### Scenario: Transcript renders in the reserved panel
- **WHEN** transcription completes for a card
- **THEN** the transcript text appears in the card's reserved transcript panel

### Requirement: Graceful degradation when unconfigured
When no STT provider member is configured, or the configured backend is unreachable, the transcription feature SHALL be hidden/disabled and the rest of Stream SHALL be unaffected.

#### Scenario: Feature hidden without a backend
- **WHEN** no STT provider member (e.g. `whisper-asr`) is configured
- **THEN** no transcribe button is shown and transcription endpoints report the feature unavailable, with no impact on other features
