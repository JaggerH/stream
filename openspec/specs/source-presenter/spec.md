## Purpose

每个源用 manifest 选定的 presenter 把原始条目归一成 Content：presenter 绝不丢条目，阅读器按 archetype 渲染。

## Requirements

### Requirement: Manifest selects a presenter
A source manifest MAY name a `presenter`. The pipeline SHALL resolve raw adapter items to a normalized `Content` value using the named presenter, falling back to a default presenter when none is named.

#### Scenario: Named presenter used
- **WHEN** a manifest names `presenter: xhs` and an item flows through the pipeline
- **THEN** the xhs presenter produces the item's `Content`

#### Scenario: Default presenter fallback
- **WHEN** a manifest names no presenter
- **THEN** the default presenter produces the item's `Content`

### Requirement: Presenter normalizes raw items to Content
A presenter SHALL map a raw adapter item to a `Content` value carrying an `archetype` and typed media, so the reader can render any source uniformly. Supported archetypes SHALL include text, article, video, gallery, link, and forward.

#### Scenario: Note with images becomes a gallery
- **WHEN** the xhs presenter receives a note carrying image media
- **THEN** it produces `Content` with archetype `gallery`, the note text, the author, and the images as typed media

#### Scenario: Note with a video becomes a video archetype
- **WHEN** the xhs presenter receives a note carrying a video
- **THEN** it produces `Content` with archetype `video` plus the note text and author

### Requirement: A presenter never drops an item
Presenter failure SHALL NOT drop an item. When a presenter throws, the pipeline SHALL fall back to a plain-text `Content` derived from the raw item.

#### Scenario: Broken presenter falls back to text
- **WHEN** a presenter throws while normalizing an item
- **THEN** the pipeline emits a plain-text `Content` for that item instead of discarding it

### Requirement: Reader renders by archetype
The frontend reader SHALL render an item from its `Content.archetype` and typed media, independent of which source or adapter produced it.

#### Scenario: Uniform rendering across sources
- **WHEN** two items from different sources share archetype `gallery`
- **THEN** the reader renders both with the same gallery affordance
