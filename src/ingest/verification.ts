import { createHash } from 'node:crypto';

export interface CanonicalMediaDescriptor {
  type: 'image' | 'video' | 'audio' | 'file' | 'pdf';
  caption: string;
  source: string;
  color: string;
}

export interface CanonicalTableDescriptor {
  fit_page_width: boolean;
  header_row: boolean;
  header_column: boolean;
  column_colors: string[];
  row_colors: string[];
  cell_colors: string[][];
  rows: string[][];
}

export interface CanonicalMarkdown {
  content_shape: string;
  links: string[];
  media: CanonicalMediaDescriptor[];
  tables: CanonicalTableDescriptor[];
}

export interface MarkdownComparisonOptions {
  ignore_media_sources?: boolean;
}

interface ParsedLink {
  end: number;
  caption: string;
  source: string;
}

type CanonicalTokenKind = 'literal' | 'table' | 'media' | 'link';

interface CanonicalTokenContext {
  prefix: string;
  suffix: string;
  token: (kind: CanonicalTokenKind, index: number) => string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function canonicalUrl(value: string): string {
  const decoded = decodeHtmlEntities(value);
  try {
    return new URL(decoded).href;
  } catch {
    return decoded;
  }
}

function hashLiteral(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createTokenContext(markdown: string): CanonicalTokenContext {
  let prefix = `\uE000notion-cli-${hashLiteral(markdown)}-`;
  while (markdown.includes(prefix)) prefix += 'x';
  const suffix = '\uE001';
  return {
    prefix,
    suffix,
    token: (kind, index) => `${prefix}${kind}:${index}${suffix}`,
  };
}

function protectInlineCode(line: string, protect: (value: string) => string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf('`', cursor);
    if (opening < 0) {
      parts.push(line.slice(cursor));
      break;
    }
    parts.push(line.slice(cursor, opening));
    let endOfRun = opening + 1;
    while (line[endOfRun] === '`') endOfRun += 1;
    const marker = line.slice(opening, endOfRun);
    const closing = line.indexOf(marker, endOfRun);
    if (closing < 0) {
      parts.push(line.slice(opening));
      break;
    }
    const end = closing + marker.length;
    parts.push(protect(line.slice(opening, end)));
    cursor = end;
  }
  return parts.join('');
}

function protectCode(
  markdown: string,
  tokens: CanonicalTokenContext,
): { markdown: string; literals: string[] } {
  const literals: string[] = [];
  const protect = (value: string): string => {
    const index = literals.length;
    literals.push(hashLiteral(value));
    return tokens.token('literal', index);
  };
  const output: string[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const lineEnd = markdown.indexOf('\n', cursor);
    const contentEnd = lineEnd < 0 ? markdown.length : lineEnd;
    const line = markdown.slice(cursor, contentEnd);
    const opening = line.match(/^(\t*)(`{3,})/);
    if (!opening) {
      output.push(protectInlineCode(line, protect));
      if (lineEnd >= 0) output.push('\n');
      cursor = lineEnd < 0 ? markdown.length : lineEnd + 1;
      continue;
    }

    const indentation = opening[1];
    const marker = opening[2];
    let search = lineEnd < 0 ? markdown.length : lineEnd + 1;
    let blockEnd = markdown.length;
    while (search < markdown.length) {
      const candidateEnd = markdown.indexOf('\n', search);
      const candidateContentEnd = candidateEnd < 0 ? markdown.length : candidateEnd;
      const candidate = markdown.slice(search, candidateContentEnd);
      if (candidate === `${indentation}${marker}`) {
        blockEnd = candidateEnd < 0 ? markdown.length : candidateEnd + 1;
        break;
      }
      search = candidateEnd < 0 ? markdown.length : candidateEnd + 1;
    }
    output.push(protect(markdown.slice(cursor, blockEnd)));
    cursor = blockEnd;
  }
  return { markdown: output.join(''), literals };
}

function structuredContentShape(
  markdown: string,
  tokens: CanonicalTokenContext,
  literals: readonly string[],
): string {
  const normalized = markdown
    .split('\n')
    .map(line => line.trimEnd())
    // Notion strips plain blank lines; an intentional blank block is represented
    // explicitly as <empty-block/> and therefore remains in the shape.
    .filter(line => line !== '')
    .join('\n');
  const segments: Array<Record<string, string | number>> = [];
  const appendText = (value: string): void => {
    if (value.length === 0) return;
    const previous = segments.at(-1);
    if (previous?.type === 'text') {
      previous.value = `${previous.value ?? ''}${value}`;
    } else {
      segments.push({ type: 'text', value });
    }
  };
  let cursor = 0;
  while (cursor < normalized.length) {
    const opening = normalized.indexOf(tokens.prefix, cursor);
    if (opening < 0) {
      appendText(normalized.slice(cursor));
      break;
    }
    appendText(normalized.slice(cursor, opening));
    const bodyStart = opening + tokens.prefix.length;
    const closing = normalized.indexOf(tokens.suffix, bodyStart);
    if (closing < 0) {
      appendText(normalized.slice(opening));
      break;
    }
    const match = normalized.slice(bodyStart, closing)
      .match(/^(literal|table|media|link):(\d+)$/);
    if (!match) {
      appendText(normalized.slice(opening, closing + tokens.suffix.length));
      cursor = closing + tokens.suffix.length;
      continue;
    }
    const kind = match[1] as CanonicalTokenKind;
    const index = Number(match[2]);
    if (kind === 'literal') {
      segments.push({ type: kind, sha256: literals[index] ?? 'missing' });
    } else {
      segments.push({ type: kind, index });
    }
    cursor = closing + tokens.suffix.length;
  }
  return JSON.stringify(segments);
}

function parseLinkAt(value: string, start: number, image: boolean): ParsedLink | null {
  const captionStart = start + (image ? 2 : 1);
  let cursor = captionStart;
  let captionEnd = -1;
  while (cursor < value.length) {
    if (value[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (value[cursor] === ']' && value[cursor + 1] === '(') {
      captionEnd = cursor;
      break;
    }
    cursor += 1;
  }
  if (captionEnd < 0) return null;
  const sourceStart = captionEnd + 2;
  cursor = sourceStart;
  while (cursor < value.length) {
    if (value[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (value[cursor] === ')') {
      return {
        end: cursor + 1,
        caption: value.slice(captionStart, captionEnd),
        source: value.slice(sourceStart, cursor),
      };
    }
    cursor += 1;
  }
  return null;
}

function replaceLinks(
  value: string,
  onLink: (link: ParsedLink) => string,
): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf('[', cursor);
    if (opening < 0) {
      parts.push(value.slice(cursor));
      break;
    }
    if (opening > 0 && value[opening - 1] === '!') {
      parts.push(value.slice(cursor, opening + 1));
      cursor = opening + 1;
      continue;
    }
    parts.push(value.slice(cursor, opening));
    const parsed = parseLinkAt(value, opening, false);
    if (!parsed) {
      parts.push(value.slice(opening));
      break;
    }
    parts.push(onLink(parsed));
    cursor = parsed.end;
  }
  return parts.join('');
}

function canonicalInline(value: string): string {
  return replaceLinks(value, link => (
    `[${link.caption}](${canonicalUrl(link.source)})`
  )).replace(/\s+/g, ' ').trim();
}

function tagBoundary(character: string | undefined): boolean {
  return character === undefined || character === '>' || /\s/.test(character);
}

interface TaggedBody {
  attributes: string;
  body: string;
}

function tagBodies(value: string, tag: string): TaggedBody[] {
  const lower = value.toLowerCase();
  const openingToken = `<${tag}`;
  const closingToken = `</${tag}>`;
  const bodies: TaggedBody[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = lower.indexOf(openingToken, cursor);
    if (opening < 0) break;
    if (!tagBoundary(lower[opening + openingToken.length])) {
      cursor = opening + openingToken.length;
      continue;
    }
    const openingEnd = lower.indexOf('>', opening + openingToken.length);
    if (openingEnd < 0) break;
    const closing = lower.indexOf(closingToken, openingEnd + 1);
    if (closing < 0) break;
    bodies.push({
      attributes: value.slice(opening + openingToken.length, openingEnd),
      body: value.slice(openingEnd + 1, closing),
    });
    cursor = closing + closingToken.length;
  }
  return bodies;
}

function startTagAttributes(value: string, tag: string): string[] {
  const lower = value.toLowerCase();
  const openingToken = `<${tag}`;
  const attributes: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = lower.indexOf(openingToken, cursor);
    if (opening < 0) break;
    if (!tagBoundary(lower[opening + openingToken.length])) {
      cursor = opening + openingToken.length;
      continue;
    }
    const openingEnd = lower.indexOf('>', opening + openingToken.length);
    if (openingEnd < 0) break;
    attributes.push(value.slice(opening + openingToken.length, openingEnd));
    cursor = openingEnd + 1;
  }
  return attributes;
}

function attributeValue(attributes: string, name: string): string {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return decodeHtmlEntities(match?.[1] ?? '').trim().toLowerCase();
}

function booleanAttribute(attributes: string, name: string): boolean {
  return attributeValue(attributes, name) === 'true';
}

function splitPipeRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === '\\' && index + 1 < line.length - 1) {
      current += character + line[index + 1];
      index += 1;
    } else if (character === '|') {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

function pipeDivider(row: readonly string[]): boolean {
  return row.length > 0 && row.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function canonicalizePipeTables(
  markdown: string,
  tables: CanonicalTableDescriptor[],
  tokens: CanonicalTokenContext,
): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index;
    const rawRows: string[][] = [];
    while (end < lines.length) {
      const candidate = lines[end].trim();
      if (!candidate.startsWith('|') || !candidate.endsWith('|')) break;
      rawRows.push(splitPipeRow(candidate));
      end += 1;
    }
    const dividerIndex = rawRows.findIndex(pipeDivider);
    if (rawRows.length < 2 || dividerIndex < 0) {
      output.push(...lines.slice(index, end));
      index = end;
      continue;
    }
    const tableIndex = tables.length;
    const rows = rawRows
      .filter((_row, rowIndex) => rowIndex !== dividerIndex)
      .map(row => row.map(canonicalInline));
    const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    tables.push({
      fit_page_width: false,
      header_row: dividerIndex === 1,
      header_column: false,
      column_colors: Array<string>(width).fill(''),
      row_colors: Array<string>(rows.length).fill(''),
      cell_colors: rows.map(row => Array<string>(row.length).fill('')),
      rows,
    });
    output.push(tokens.token('table', tableIndex));
    index = end;
  }
  return output.join('\n');
}

function canonicalizeTables(
  markdown: string,
  tokens: CanonicalTokenContext,
): {
  markdown: string;
  tables: CanonicalTableDescriptor[];
} {
  const lower = markdown.toLowerCase();
  const tables: CanonicalTableDescriptor[] = [];
  const output: string[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const opening = lower.indexOf('<table', cursor);
    if (opening < 0) {
      output.push(markdown.slice(cursor));
      break;
    }
    if (!tagBoundary(lower[opening + 6])) {
      output.push(markdown.slice(cursor, opening + 6));
      cursor = opening + 6;
      continue;
    }
    const openingEnd = lower.indexOf('>', opening + 6);
    const closing = openingEnd < 0 ? -1 : lower.indexOf('</table>', openingEnd + 1);
    if (openingEnd < 0 || closing < 0) {
      output.push(markdown.slice(cursor));
      break;
    }
    output.push(markdown.slice(cursor, opening));
    const attributes = markdown.slice(opening + 6, openingEnd);
    const body = markdown.slice(openingEnd + 1, closing);
    const rowEntries = tagBodies(body, 'tr');
    const cellEntries = rowEntries.map(row => tagBodies(row.body, 'td'));
    const rows = cellEntries
      .map(cells => cells.map(cell => canonicalInline(cell.body)))
      .filter(row => row.length > 0);
    const nonemptyRowEntries = rowEntries.filter((_row, rowIndex) => (
      cellEntries[rowIndex].length > 0
    ));
    const nonemptyCellEntries = cellEntries.filter(cells => cells.length > 0);
    const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    const columnAttributes = startTagAttributes(body, 'col');
    const index = tables.length;
    tables.push({
      fit_page_width: booleanAttribute(attributes, 'fit-page-width'),
      header_row: booleanAttribute(attributes, 'header-row'),
      header_column: booleanAttribute(attributes, 'header-column'),
      column_colors: Array.from(
        { length: width },
        (_unused, columnIndex) => attributeValue(columnAttributes[columnIndex] ?? '', 'color'),
      ),
      row_colors: nonemptyRowEntries.map(row => attributeValue(row.attributes, 'color')),
      cell_colors: nonemptyCellEntries.map(cells => (
        cells.map(cell => attributeValue(cell.attributes, 'color'))
      )),
      rows,
    });
    output.push(`\n${tokens.token('table', index)}\n`);
    cursor = closing + '</table>'.length;
  }
  return {
    markdown: canonicalizePipeTables(output.join(''), tables, tokens),
    tables,
  };
}

function replaceImages(
  value: string,
  media: CanonicalMediaDescriptor[],
  tokens: CanonicalTokenContext,
): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf('![', cursor);
    if (opening < 0) {
      parts.push(value.slice(cursor));
      break;
    }
    parts.push(value.slice(cursor, opening));
    const parsed = parseLinkAt(value, opening, true);
    if (!parsed) {
      parts.push(value.slice(opening));
      break;
    }
    const index = media.length;
    const caption = canonicalInline(parsed.caption);
    const blockColor = value.slice(parsed.end).match(/^[ \t]+\{color="([^"]+)"\}/i);
    const color = blockColor ? blockColor[1].trim().toLowerCase() : '';
    media.push({ type: 'image', caption, source: canonicalUrl(parsed.source), color });
    parts.push(`${tokens.token('media', index)}[${caption}]`);
    cursor = parsed.end + (blockColor?.[0].length ?? 0);
  }
  return parts.join('');
}

function replaceXmlMedia(
  value: string,
  media: CanonicalMediaDescriptor[],
  tokens: CanonicalTokenContext,
): string {
  const lower = value.toLowerCase();
  const tags = ['video', 'audio', 'file', 'pdf'] as const;
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = lower.indexOf('<', cursor);
    if (opening < 0) {
      parts.push(value.slice(cursor));
      break;
    }
    let type: typeof tags[number] | undefined;
    for (const candidate of tags) {
      if (
        lower.startsWith(`<${candidate}`, opening)
        && tagBoundary(lower[opening + candidate.length + 1])
      ) {
        type = candidate;
        break;
      }
    }
    if (!type) {
      parts.push(value.slice(cursor, opening + 1));
      cursor = opening + 1;
      continue;
    }
    const openingEnd = lower.indexOf('>', opening + type.length + 1);
    const closingToken = `</${type}>`;
    const closing = openingEnd < 0 ? -1 : lower.indexOf(closingToken, openingEnd + 1);
    if (openingEnd < 0 || closing < 0) {
      parts.push(value.slice(cursor));
      break;
    }
    parts.push(value.slice(cursor, opening));
    const attributes = value.slice(opening + type.length + 1, openingEnd);
    const caption = canonicalInline(value.slice(openingEnd + 1, closing));
    const source = attributes.match(/\bsrc="([^"]+)"/i)?.[1] ?? '';
    const color = attributeValue(attributes, 'color');
    const index = media.length;
    media.push({ type, caption, source: canonicalUrl(source), color });
    parts.push(`${tokens.token('media', index)}[${caption}]`);
    cursor = closing + closingToken.length;
  }
  return parts.join('');
}

export function canonicalizeEnhancedMarkdown(markdown: string): CanonicalMarkdown {
  const normalizedMarkdown = markdown.replaceAll('\r\n', '\n');
  const tokens = createTokenContext(normalizedMarkdown);
  const protectedCode = protectCode(normalizedMarkdown, tokens);
  const canonicalTables = canonicalizeTables(protectedCode.markdown, tokens);
  const media: CanonicalMediaDescriptor[] = [];
  let content = replaceImages(canonicalTables.markdown, media, tokens);
  content = replaceXmlMedia(content, media, tokens);

  const links: string[] = [];
  content = replaceLinks(content, (link) => {
    const index = links.length;
    links.push(canonicalUrl(link.source));
    return `${tokens.token('link', index)}[${canonicalInline(link.caption)}]`;
  });
  content = content.replace(
    /^(\t*)\d+[.)](\s+)/gm,
    (_match, indent: string, spacing: string) => `${indent}1.${spacing}`,
  );
  const contentShape = structuredContentShape(content, tokens, protectedCode.literals);

  return {
    content_shape: contentShape,
    links,
    media,
    tables: canonicalTables.tables,
  };
}

export function compareEnhancedMarkdown(
  expected: string,
  actual: string,
  options: MarkdownComparisonOptions = {},
): string | null {
  const expectedCanonical = canonicalizeEnhancedMarkdown(expected);
  const actualCanonical = canonicalizeEnhancedMarkdown(actual);
  if (expectedCanonical.content_shape !== actualCanonical.content_shape) {
    return 'different canonical content or annotation placement';
  }
  if (JSON.stringify(expectedCanonical.tables) !== JSON.stringify(actualCanonical.tables)) {
    return 'different table rows, columns, formatting, links, or header structure';
  }
  if (JSON.stringify(expectedCanonical.links) !== JSON.stringify(actualCanonical.links)) {
    return 'different ordered link destinations';
  }
  const mediaShape = (items: readonly CanonicalMediaDescriptor[]) => items.map((item) => ({
    type: item.type,
    caption: item.caption,
    color: item.color,
    ...(options.ignore_media_sources ? {} : { source: item.source }),
  }));
  if (JSON.stringify(mediaShape(expectedCanonical.media)) !== JSON.stringify(mediaShape(actualCanonical.media))) {
    return options.ignore_media_sources
      ? 'different ordered media types, captions, or colors'
      : 'different ordered media types, captions, colors, or destinations';
  }
  return null;
}
