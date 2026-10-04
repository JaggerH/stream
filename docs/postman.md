# Postman Request Naming Standards

> **Registry locations**: the collection source of truth is
> `docs/postman/stream.postman_collection.json` (in-repo, versioned); the online mirror is the
> `stream` collection in My Workspace (uid `32927570-2df427de-4f9b-4746-8483-cb01ebbfcded`).
> Endpoint changes update the repo file first, then push with
> **`node scripts/postman-push.mjs`** (auth: `POSTMAN_API_KEY` env, falls back to the postman
> MCP server's env in `~/.claude.json`). Never inline the collection through MCP putCollection —
> the script reads the file directly, zero token cost.

## Principles & Rules

1. **Object-First Naming (Nouns First)**:
   - Do **NOT** start request names with action verbs (e.g. *Get*, *Post*, *Fetch*, *Create*, *Delete*).
   - Start request names with the **subject object** (e.g. *Channel*, *Stream*, *System*). This naturally groups requests of the same resource together alphabetically.

## Object Naming Schema Examples

| Endpoint | Bad Name (Verb-First) | Good Name (Object-First) |
| :--- | :--- | :--- |
| `GET /api/channels` | `Get Channels` | `Channel: List` |
| `GET /api/channels?kind=audio` | `Get Audio Channels` | `Channel: Audio List` |
| `GET /api/resolve/targets` | `Resolve Targets` | `Channel: Resolve Health` |
| `GET /api/streams` | `Get Streams` | `Stream: List` |
| `GET /api/items` | `Get Items` | `Item: Inbox List` |
| `GET /api/health` | `Get Health` | `System: Health Probe` |
| `GET /api/status` | `Get Status` | `System: Status Info` |
