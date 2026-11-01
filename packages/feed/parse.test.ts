import { describe, it, expect } from 'vitest'
import { parseFeed } from './parse.ts'

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Example Changelog</title>
  <link>https://example.com/changelog</link>
  <description>Recent changes</description>
  <item>
    <title>Release 2.0 &amp; friends</title>
    <link>https://example.com/changelog/2-0</link>
    <guid isPermaLink="false">release-2-0</guid>
    <pubDate>Wed, 01 Nov 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Teaser only</p>]]></description>
    <content:encoded><![CDATA[<p>Full body with <b>markup</b></p>]]></content:encoded>
    <author>jane@example.com (Jane Doe)</author>
  </item>
  <item>
    <title>Release 1.9</title>
    <link>https://example.com/changelog/1-9</link>
    <guid>https://example.com/changelog/1-9</guid>
    <pubDate>Tue, 01 Oct 2026 10:00:00 GMT</pubDate>
    <description>Plain teaser</description>
  </item>
</channel>
</rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Releases</title>
  <link rel="self" href="https://example.com/releases.atom"/>
  <link rel="alternate" href="https://example.com/releases"/>
  <entry>
    <id>tag:example.com,2026:release-2-0</id>
    <title>Release 2.0</title>
    <link rel="alternate" href="https://example.com/releases/2-0"/>
    <published>2026-11-01T10:00:00Z</published>
    <updated>2026-11-01T11:00:00Z</updated>
    <summary>Teaser</summary>
    <content type="html">&lt;p&gt;Full atom body&lt;/p&gt;</content>
    <author><name>Jane Doe</name></author>
  </entry>
</feed>`

describe('parseFeed — RSS 2.0', () => {
  const f = parseFeed(RSS)
  it('parses every item with the feed\'s own guid as identity', () => {
    expect(f.items).toHaveLength(2)
    expect(f.items[0]!.guid).toBe('release-2-0')
    expect(f.items[1]!.guid).toBe('https://example.com/changelog/1-9')
  })
  it('channel title comes from the feed, not any item', () => {
    expect(f.title).toBe('Example Changelog')
  })
  it('content:encoded wins over the teaser description; entities decode', () => {
    expect(f.items[0]!.description).toContain('Full body')
    expect(f.items[0]!.title).toBe('Release 2.0 & friends')
    expect(f.items[0]!.author).toContain('Jane')
  })
  it('pubDate is carried verbatim for makeStreamItem to parse', () => {
    expect(f.items[0]!.pubDate).toBe('Wed, 01 Nov 2026 10:00:00 GMT')
  })
})

describe('parseFeed — Atom', () => {
  const f = parseFeed(ATOM)
  it('parses entries with <id> as identity and rel=alternate as the link', () => {
    expect(f.items).toHaveLength(1)
    expect(f.items[0]!.guid).toBe('tag:example.com,2026:release-2-0')
    expect(f.items[0]!.link).toBe('https://example.com/releases/2-0')
  })
  it('content beats summary; published wins for the timestamp', () => {
    expect(f.items[0]!.description).toContain('Full atom body')
    expect(f.items[0]!.pubDate).toBe('2026-11-01T10:00:00Z')
    expect(f.title).toBe('Example Releases')
  })
})

describe('parseFeed — degenerate inputs', () => {
  it('an HTML page parses to zero items (adapter turns that into an error)', () => {
    expect(parseFeed('<html><body><h1>hello</h1></body></html>').items).toHaveLength(0)
  })
  it('an entry without any identity is skipped, not emitted dedup-less', () => {
    const f = parseFeed('<rss><channel><item><title>no id no link</title></item></channel></rss>')
    expect(f.items).toHaveLength(0)
  })
})
