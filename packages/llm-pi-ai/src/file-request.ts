/**
 * Request-time generic-file preparation for the pi-ai adapter.
 *
 * Durable generic-file attachments (the composer's paperclip non-image path)
 * are stored as opaque bytes. Provider requests, however, speak text and
 * images only on every wire this adapter serves — so to make an attached
 * document model-visible the adapter projects its bytes into a delimited
 * textual representation at request time:
 *
 * - Office Open XML packages are unzipped and flattened: `.docx` word
 *   processing (word/document.xml), `.pptx` presentations (slides in order),
 *   `.xlsx` spreadsheets (shared strings + named worksheets).
 * - OpenDocument packages (.odt/.ods/.odp/...) and EPUB books are flattened
 *   from their XML/XHTML members the same way.
 * - PDFs are extracted page-by-page through pdf.js (via `unpdf`).
 * - Text-like media types and extensions are decoded as UTF-8.
 * - Anything else (and any file whose extraction or byte read fails) degrades
 *   to the historical name-only note, so a request never fails because one
 *   attachment could not be represented.
 *
 * A per-request character budget bounds how much extracted text rides one
 * provider call; files beyond the budget degrade to the note in message order,
 * mirroring how image offloading drops the oldest images first.
 *
 * @module dsh-llm-pi-ai/file-request
 */

import { strFromU8, unzipSync } from 'fflate'
import type { AttachmentId, AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Media types declared by browsers for the Office Open XML families. */
const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** EPUB and PDF media types; OpenDocument is a whole `vnd.oasis.opendocument.` prefix. */
const EPUB_MEDIA_TYPE = 'application/epub+zip'
const PDF_MEDIA_TYPE = 'application/pdf'
const ODF_MEDIA_TYPE_PREFIX = 'application/vnd.oasis.opendocument.'

/** Structured (non-plain-text) document families with a dedicated extractor. */
type StructuredKind = 'docx' | 'pptx' | 'xlsx' | 'odf' | 'epub' | 'pdf'

/**
 * Default total budget for extracted attachment text in one provider request.
 * 200k characters is roughly 50k tokens of context headroom — large enough for
 * a full essay-sized document plus history, small enough that a request stays
 * far below typical gateway body caps after images and tools are added.
 */
export const DEFAULT_MAX_REQUEST_FILE_TEXT_CHARS = 200_000

/** Why one file's contents did not ride the request. */
export type FileTextOmissionReason = 'read-failed' | 'binary' | 'budget'

/** One durable file's request-time projection. */
export interface PreparedFileText {
  /** The durable reference this projection was prepared from. */
  readonly ref: FileAttachmentRef
  /** Extracted textual contents when the file rides the request; otherwise absent. */
  readonly text?: string
  /** True when {@link PreparedFileText.text} was cut short by the request budget. */
  readonly truncated?: boolean
  /** Present when the contents did not ride the request; names why. */
  readonly omission?: FileTextOmissionReason
}

/** Extensions treated as decodable text when the browser declared no useful media type. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'xml', 'svg', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'psm1', 'psd1', 'sql', 'r', 'lua', 'pl', 'log', 'srt', 'vtt',
])

/** Media types treated as decodable text regardless of extension. */
function isTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true
  return [
    'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
    'application/toml', 'application/javascript', 'application/ecmascript',
    'application/sql', 'application/graphql', 'application/ld+json',
    'application/xhtml+xml', 'application/rss+xml', 'application/atom+xml',
  ].includes(mediaType)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** True when the bytes should decode as UTF-8 rather than degrade to a note. */
function isTextLike(ref: Pick<FileAttachmentRef, 'mediaType' | 'name'>): boolean {
  if (ref.mediaType !== '' && ref.mediaType !== 'application/octet-stream') {
    return isTextMediaType(ref.mediaType) || TEXT_EXTENSIONS.has(extensionOf(ref.name))
  }
  return TEXT_EXTENSIONS.has(extensionOf(ref.name))
}

/**
 * Which structured extractor owns one attachment, by declared media type first
 * and filename extension second (browser labels are best-effort). Legacy OLE
 * binaries (.doc/.xls/.ppt) intentionally have no kind: they are not zip
 * packages and degrade to the honest name-only note instead.
 */
function structuredKindOf(ref: Pick<FileAttachmentRef, 'mediaType' | 'name'>): StructuredKind | undefined {
  const mediaType = ref.mediaType.toLowerCase()
  const ext = extensionOf(ref.name)
  if (mediaType === DOCX_MEDIA_TYPE || ext === 'docx') return 'docx'
  if (mediaType === PPTX_MEDIA_TYPE || ext === 'pptx') return 'pptx'
  if (mediaType === XLSX_MEDIA_TYPE || ext === 'xlsx') return 'xlsx'
  if (mediaType === EPUB_MEDIA_TYPE || ext === 'epub') return 'epub'
  if (mediaType === PDF_MEDIA_TYPE || ext === 'pdf') return 'pdf'
  if (mediaType.startsWith(ODF_MEDIA_TYPE_PREFIX) || ['odt', 'ods', 'odp', 'odg'].includes(ext)) return 'odf'
  return undefined
}

/** Undo the five XML predefined entities plus numeric character references. */
function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Collapse indentation-and-blank-line runs a decorative layout would produce. */
function collapseBlankRuns(text: string): string {
  return text.replace(/[ \t]*\n[ \t\n]*/g, '\n').replace(/^\n+|\n+$/g, '')
}

/** Open a package and read one member as text; undefined when either fails. */
function memberText(zip: Record<string, Uint8Array>, path: string): string | undefined {
  const member = zip[path]
  if (member === undefined) return undefined
  try {
    return strFromU8(member)
  } catch {
    return undefined
  }
}

function openZip(data: Uint8Array): Record<string, Uint8Array> | undefined {
  try {
    return unzipSync(data)
  } catch {
    return undefined
  }
}

/** Sort paths by the number they end in (slide7 after slide2), then lexically. */
function numericPathSort(left: string, right: string): number {
  const l = /(\d+)\.[^.]+$/.exec(left)?.[1]
  const r = /(\d+)\.[^.]+$/.exec(right)?.[1]
  if (l !== undefined && r !== undefined) {
    const delta = Number(l) - Number(r)
    if (delta !== 0) return delta
  }
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Flatten one `.docx` payload into paragraphs of plain text. WordprocessingML
 * carries the visible text inside `<w:t>` runs; paragraph, table-row, and cell
 * ends become line breaks and tabs so structure survives the projection. Field
 * instruction text (`<w:instrText>`), comments, and deleted-range markers are
 * naturally excluded because only `w:t` runs are read.
 * @returns the flattened text, or undefined when the payload is not a readable docx.
 */
export function extractDocxText(data: Uint8Array): string | undefined {
  const zip = openZip(data)
  if (zip === undefined || zip['word/document.xml'] === undefined) return undefined
  const xml = memberText(zip, 'word/document.xml')
  if (xml === undefined) return undefined
  let out = ''
  // One ordered scan keeps runs and structural boundaries interleaved correctly.
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:tc>|<\/w:p>|<\/w:tr>/g
  for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
    if (match[1] !== undefined) out += unescapeXml(match[1])
    else if (match[0] === '</w:tc>' || match[0] === '<w:tab/>') out += '\t'
    else out += '\n' // paragraph, break, and table-row ends
  }
  // A paragraph end directly before a cell boundary is one break, not two.
  return collapseBlankRuns(out.replace(/\n\t/g, '\t'))
}

/**
 * Flatten one `.pptx` payload: every slide's `<a:t>` runs in deck order, one
 * paragraph per shape line, slides separated by single line breaks. Speaker
 * notes are deliberately excluded — the visible deck is what an attachment
 * reviewer means by its contents.
 */
export function extractPptxText(data: Uint8Array): string | undefined {
  const zip = openZip(data)
  if (zip === undefined) return undefined
  const slides = Object.keys(zip).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort(numericPathSort)
  if (slides.length === 0) return undefined
  const rendered: string[] = []
  for (const slide of slides) {
    const xml = memberText(zip, slide)
    if (xml === undefined) continue
    let out = ''
    const token = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\/>|<a:tab\/>|<\/a:p>/g
    for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
      if (match[1] !== undefined) out += unescapeXml(match[1])
      else if (match[0] === '<a:tab/>') out += '\t'
      else out += '\n' // paragraph ends and soft breaks
    }
    const collapsed = collapseBlankRuns(out)
    if (collapsed.length > 0) rendered.push(collapsed)
  }
  return rendered.length === 0 ? undefined : rendered.join('\n')
}

/** Read the shared-strings table every `.xlsx` worksheet cell indexes into. */
function sharedStringsOf(xml: string): string[] {
  const strings: string[] = []
  for (const item of xml.match(/<si\b[^>]*>([\s\S]*?)<\/si>/g) ?? []) {
    let text = ''
    for (const run of item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(run[1] ?? '')
    strings.push(text)
  }
  return strings
}

/** Resolve one worksheet cell to its display text against the shared strings. */
function cellValue(cellXml: string, shared: readonly string[]): string {
  if (/t="inlineStr"/.test(cellXml)) {
    let text = ''
    for (const run of cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(run[1] ?? '')
    return text
  }
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1]
  if (value === undefined) return ''
  if (/t="s"/.test(cellXml)) {
    const index = Number.parseInt(value, 10)
    return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] ?? '' : ''
  }
  return unescapeXml(value)
}

/** Map a workbook relationship target onto its zip member path. */
function worksheetTarget(target: string): string {
  const bare = target.replace(/^\//, '').replace(/^xl\//, '')
  return 'xl/' + bare
}

/** Every worksheet in workbook order, with its human name when the workbook declares one. */
function worksheetsOf(zip: Record<string, Uint8Array>): { name: string; path: string }[] {
  const namesByRel = new Map<string, string>()
  const workbookXml = memberText(zip, 'xl/workbook.xml')
  if (workbookXml !== undefined) {
    for (const tag of workbookXml.match(/<sheet\b[^>]*>/g) ?? []) {
      const rel = /r:id="([^"]+)"/.exec(tag)?.[1]
      const name = /name="([^"]*)"/.exec(tag)?.[1]
      if (rel !== undefined && name !== undefined) namesByRel.set(rel, unescapeXml(name))
    }
  }
  const entries: { name: string; path: string }[] = []
  const relsXml = memberText(zip, 'xl/_rels/workbook.xml.rels')
  if (relsXml !== undefined) {
    for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
      const rel = /Id="([^"]+)"/.exec(tag)?.[1]
      const target = /Target="([^"]+)"/.exec(tag)?.[1]
      if (rel === undefined || target === undefined || !/worksheets\//.test(target)) continue
      const path = worksheetTarget(target)
      if (zip[path] !== undefined) entries.push({ name: namesByRel.get(rel) ?? path, path })
    }
  }
  // Any worksheet the relationships missed still renders, under its file name.
  const covered = new Set(entries.map(entry => entry.path))
  for (const path of Object.keys(zip)) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(path) && !covered.has(path)) {
      entries.push({ name: path.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), path })
    }
  }
  return entries.sort((left, right) => numericPathSort(left.path, right.path))
}

/**
 * Flatten one `.xlsx` payload: one bracketed section per worksheet in workbook
 * order, rows as tab-separated cell lines. Shared-string, inline-string,
 * formula-string, boolean, and numeric cells all resolve to display text.
 */
export function extractXlsxText(data: Uint8Array): string | undefined {
  const zip = openZip(data)
  if (zip === undefined) return undefined
  const sharedXml = memberText(zip, 'xl/sharedStrings.xml')
  const shared = sharedXml === undefined ? [] : sharedStringsOf(sharedXml)
  const worksheets = worksheetsOf(zip)
  if (worksheets.length === 0) return undefined
  const sections: string[] = []
  for (const worksheet of worksheets) {
    const xml = memberText(zip, worksheet.path)
    if (xml === undefined) continue
    const lines: string[] = []
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of (row[1] ?? '').matchAll(/<c\b[^>]*(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        cells.push(cellValue(cell[0], shared))
      }
      const line = cells.join('\t').replace(/\t+$/, '')
      if (line.length > 0) lines.push(line)
    }
    if (lines.length > 0) sections.push('[' + worksheet.name + ']\n' + lines.join('\n'))
  }
  return sections.length === 0 ? undefined : sections.join('\n\n')
}

/**
 * Flatten one OpenDocument package (.odt/.ods/.odp/.odg): paragraph, heading,
 * table-cell, and table-row boundaries become line breaks and tabs, embedded
 * whitespace elements become their glyphs, and every other tag drops away so
 * the raw text nodes survive.
 */
export function extractOdfText(data: Uint8Array): string | undefined {
  const zip = openZip(data)
  if (zip === undefined || zip['content.xml'] === undefined) return undefined
  const xml = memberText(zip, 'content.xml')
  if (xml === undefined) return undefined
  const marked = xml
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:s\b[^>]*\/>/g, ' ')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<\/text:(?:h|p)>/g, '\n')
    .replace(/<\/table:table-cell>/g, '\t')
    .replace(/<\/table:table-row>/g, '\n')
  const stripped = marked.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '')
  // A paragraph end directly before a cell boundary is one break, not two,
  // and decorative multi-space runs collapse like the blank lines do.
  const text = collapseBlankRuns(unescapeXml(stripped).replace(/\n\t/g, '\t').replace(/ {2,}/g, ' '))
  return text.length > 0 ? text : undefined
}

/**
 * Flatten one EPUB book: every XHTML content document in spine-file order
 * becomes block-separated plain text, documents joined by line breaks.
 */
export function extractEpubText(data: Uint8Array): string | undefined {
  const zip = openZip(data)
  if (zip === undefined) return undefined
  const documents = Object.keys(zip)
    .filter(path => /\.(?:xhtml|html|htm)$/i.test(path) && !path.startsWith('META-INF/'))
    .sort(numericPathSort)
  if (documents.length === 0) return undefined
  const rendered: string[] = []
  for (const document of documents) {
    const xml = memberText(zip, document)
    if (xml === undefined) continue
    const marked = xml
      .replace(/<\/(?:p|h[1-6]|li|div|blockquote)>/gi, '\n')
      .replace(/<br\b[^>]*\/>/gi, '\n')
    const text = collapseBlankRuns(unescapeXml(marked.replace(/<[^>]*>/g, '')))
    if (text.length > 0) rendered.push(text)
  }
  return rendered.length === 0 ? undefined : rendered.join('\n')
}

/**
 * Extract a PDF's text layer page-by-page through pdf.js (`unpdf`). Image-only
 * scans carry no text layer and yield undefined, degrading to the note.
 */
export async function extractPdfText(data: Uint8Array): Promise<string | undefined> {
  try {
    // Dynamic import keeps module load light for sessions that never see a PDF.
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(data))
    const { text } = await extractText(pdf, { mergePages: true })
    const joined = Array.isArray(text) ? text.join('\n') : text
    const collapsed = collapseBlankRuns(joined)
    return collapsed.length > 0 ? collapsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Central dispatch: the textual projection of one stored attachment, or
 * undefined when no extractor can represent it (degrades to the note).
 */
export async function extractFileText(
  ref: Pick<FileAttachmentRef, 'mediaType' | 'name'>,
  data: Uint8Array,
): Promise<string | undefined> {
  switch (structuredKindOf(ref)) {
    case 'docx': return extractDocxText(data)
    case 'pptx': return extractPptxText(data)
    case 'xlsx': return extractXlsxText(data)
    case 'odf': return extractOdfText(data)
    case 'epub': return extractEpubText(data)
    case 'pdf': return extractPdfText(data)
    default: return isTextLike(ref) ? decodeTextBytes(data) : undefined
  }
}

/**
 * Decode bytes as UTF-8 text. A UTF-8 BOM is stripped; a payload whose decoded
 * form is dominated by replacement characters is reported as binary (undefined).
 */
function decodeTextBytes(data: Uint8Array): string | undefined {
  const bomOffset = data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF ? 3 : 0
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(bomOffset))
  const replacements = (decoded.match(/\uFFFD/g) ?? []).length
  if (replacements > 0 && replacements * 100 > decoded.length) return undefined
  return decoded
}

/**
 * The name-only note a degraded file projects instead of its contents. Kept
 * byte-identical to the pre-extraction wording so downstream expectations
 * (tests, prompts tuned around it) hold for degraded files too.
 */
export function fileNoteText(ref: { name: string; mediaType: string; bytes: number }): string {
  return '[Attached file: ' + ref.name + ' (' + ref.mediaType + ', ' + ref.bytes + ' bytes) - contents not included in this request.]'
}

/** The complete text projection of one prepared file block. */
export function fileBlockText(prepared: PreparedFileText): string {
  if (prepared.text === undefined) return fileNoteText(prepared.ref)
  const attrs = [
    'name="' + prepared.ref.name.replace(/"/g, '&quot;') + '"',
    'media-type="' + prepared.ref.mediaType + '"',
    'bytes="' + String(prepared.ref.bytes) + '"',
    ...(prepared.truncated === true ? ['truncated="true"'] : []),
  ].join(' ')
  return '<attached-file ' + attrs + '>\n' + prepared.text + '\n</attached-file>'
}

/** True when any message in the history carries a durable generic-file block. */
export function contentHasFile(messages: readonly Message[]): boolean {
  const walk = (blocks: readonly ContentBlock[]): boolean => blocks.some(block => (
    block.type === 'file' || (block.type === 'tool-result' && walk(block.content))
  ))
  return messages.some(message => walk(message.content))
}

/** Collect unique durable file references from message history, in first-seen order. */
export function collectFileRefs(
  messages: readonly Message[],
  refs: Map<AttachmentId, FileAttachmentRef> = new Map(),
): Map<AttachmentId, FileAttachmentRef> {
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'file') refs.set(block.attachment.attachmentId, block.attachment)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  for (const message of messages) walk(message.content)
  return refs
}

/**
 * Prepare every referenced file for one provider request against a shared
 * character budget. Reads resolve through the durable attachment store; any
 * read failure, unrepresentable payload, or exhausted budget degrades that
 * file to the name-only note instead of failing the request.
 * @param refs - unique references in inclusion order (oldest first).
 * @param attachments - durable byte resolver.
 * @param maxChars - total extracted-text characters this request may carry.
 * @param signal - cancellation for the underlying reads.
 */
export async function prepareRequestFiles(
  refs: readonly FileAttachmentRef[],
  attachments: AttachmentStore,
  maxChars: number,
  signal?: AbortSignal,
): Promise<Map<AttachmentId, PreparedFileText>> {
  const prepared = new Map<AttachmentId, PreparedFileText>()
  let remaining = maxChars
  for (const ref of refs) {
    if (remaining <= 0) {
      prepared.set(ref.attachmentId, { ref, omission: 'budget' })
      continue
    }
    try {
      const stored = await attachments.readFile(ref, signal)
      const extracted = await extractFileText(ref, stored.data)
      if (extracted === undefined || extracted.length === 0) {
        prepared.set(ref.attachmentId, { ref, omission: 'binary' })
        continue
      }
      if (extracted.length <= remaining) {
        remaining -= extracted.length
        prepared.set(ref.attachmentId, { ref, text: extracted })
        continue
      }
      // Budget exhaustion mid-file: include the fitting prefix, mark it
      // truncated, and spend the rest of this request's budget here.
      prepared.set(ref.attachmentId, { ref, text: extracted.slice(0, remaining), truncated: true })
      remaining = 0
    } catch {
      prepared.set(ref.attachmentId, { ref, omission: 'read-failed' })
    }
  }
  return prepared
}
