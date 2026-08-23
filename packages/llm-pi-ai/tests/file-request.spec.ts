/**
 * Request-time generic-file preparation: extraction, degradation, budgets.
 *
 * @module dsh-llm-pi-ai/file-request.spec
 */

import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef, StoredFileAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { collectFileRefs, contentHasFile, extractDocxText, extractEpubText, extractOdfText, extractPdfText, extractPptxText, extractXlsxText, fileBlockText, fileNoteText, prepareRequestFiles } from '../src/file-request.ts'

/** A minimal but structurally real .docx payload built around one document.xml. */
function docxBytes(bodyXml: string): Uint8Array {
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + bodyXml
    + '</w:body></w:document>'
  return zipSync({ 'word/document.xml': strToU8(document) })
}

function ref(overrides: Partial<FileAttachmentRef> & { name: string }): FileAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:' + 'b'.repeat(64)),
    mediaType: 'application/octet-stream',
    bytes: 10,
    ...overrides,
  }
}

function storeWith(files: readonly StoredFileAttachment[]): AttachmentStore {
  return {
    readImage: () => Promise.reject(new Error('no images in this spec')),
    readFile: (wanted: FileAttachmentRef) => {
      const hit = files.find(candidate => candidate.ref.attachmentId === wanted.attachmentId)
      return hit === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(hit)
    },
  } as unknown as AttachmentStore
}

function userMessage(content: readonly unknown[]): Message {
  return createUserMessage({ content: content as never, source: { kind: 'user' } })
}

describe('extractDocxText', () => {
  it('flattens paragraphs, tabs, breaks, and table cells in document order', () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">Stefan&apos;s &amp; Co.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/><w:t>after tab</w:t><w:br/><w:t>new line</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell A</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    expect(extractDocxText(docxBytes(body))).toBe(
      "Stefan's & Co.\nSecond\tafter tab\nnew line\ncell A\tcell B",
    )
  })

  it('returns undefined for a payload that is not a zip or has no word/document.xml', () => {
    expect(extractDocxText(new Uint8Array([1, 2, 3, 4]))).toBeUndefined()
    const notADocx = zipSync({ 'readme.txt': strToU8('hello') })
    expect(extractDocxText(notADocx)).toBeUndefined()
  })
})

describe('prepareRequestFiles', () => {
  it('projects a decodable text attachment with its contents and strips the BOM', async () => {
    const wanted = ref({ name: 'notes.md', mediaType: 'text/markdown' })
    const stored: StoredFileAttachment = { ref: wanted, data: new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('# Plan')]) }
    const prepared = await prepareRequestFiles([wanted], storeWith([stored]), 100_000)
    expect(prepared.get(wanted.attachmentId)).toMatchObject({ text: '# Plan' })
    expect(prepared.has(wanted.attachmentId) && prepared.get(wanted.attachmentId)?.omission).toBeUndefined()
  })

  it('extracts a docx attachment through the durable byte read', async () => {
    const wanted = ref({
      name: 'report.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: 42,
    })
    const stored: StoredFileAttachment = { ref: wanted, data: docxBytes('<w:p><w:r><w:t>Draft essay body</w:t></w:r></w:p>') }
    const prepared = await prepareRequestFiles([wanted], storeWith([stored]), 100_000)
    expect(prepared.get(wanted.attachmentId)).toMatchObject({ text: 'Draft essay body' })
  })

  it('degrades an undecodable binary to the historical name-only note', async () => {
    const wanted = ref({ name: 'archive.zip', mediaType: 'application/zip' })
    const stored: StoredFileAttachment = { ref: wanted, data: new Uint8Array([0x50, 0x4B, 0x03, 0x04]) }
    const prepared = await prepareRequestFiles([wanted], storeWith([stored]), 100_000)
    expect(prepared.get(wanted.attachmentId)).toEqual({ ref: wanted, omission: 'binary' })
    expect(fileBlockText(prepared.get(wanted.attachmentId)!)).toBe(fileNoteText(wanted))
    expect(fileBlockText(prepared.get(wanted.attachmentId)!))
      .toBe('[Attached file: archive.zip (application/zip, 10 bytes) - contents not included in this request.]')
  })

  it('degrades to read-failed when the store cannot resolve the bytes', async () => {
    const wanted = ref({ name: 'gone.txt', mediaType: 'text/plain' })
    const prepared = await prepareRequestFiles([wanted], storeWith([]), 100_000)
    expect(prepared.get(wanted.attachmentId)).toEqual({ ref: wanted, omission: 'read-failed' })
  })

  it('spends the shared character budget in order, truncating mid-file then omitting the rest', async () => {
    const first = ref({ name: 'a.txt', mediaType: 'text/plain', attachmentId: AttachmentId('sha256:' + '1'.repeat(64)) })
    const second = ref({ name: 'b.txt', mediaType: 'text/plain', attachmentId: AttachmentId('sha256:' + '2'.repeat(64)) })
    const stored = [
      { ref: first, data: new TextEncoder().encode('x'.repeat(30)) },
      { ref: second, data: new TextEncoder().encode('y'.repeat(30)) },
    ] as readonly StoredFileAttachment[]
    // Budget fits the first file whole plus half of the second.
    const prepared = await prepareRequestFiles([first, second], storeWith(stored), 45)
    const firstPrepared = prepared.get(first.attachmentId)
    expect(firstPrepared?.text).toBe('x'.repeat(30))
    expect(firstPrepared?.truncated).toBeUndefined()
    const secondPrepared = prepared.get(second.attachmentId)
    expect(secondPrepared).toMatchObject({ truncated: true })
    expect(secondPrepared?.text?.length).toBe(15)
    // A spent budget omits later files entirely without reading them again.
    const spent = await prepareRequestFiles([first, second], storeWith(stored), 20)
    expect(spent.get(first.attachmentId)).toMatchObject({ truncated: true })
    expect(spent.get(second.attachmentId)).toEqual({ ref: second, omission: 'budget' })
  })
})

describe('history predicates', () => {
  it('contentHasFile sees file blocks directly and inside tool results', () => {
    const wanted = ref({ name: 'essay.docx' })
    expect(contentHasFile([userMessage([{ type: 'text', text: 'hi' }])])).toBe(false)
    expect(contentHasFile([userMessage([{ type: 'file', attachment: wanted }])])).toBe(true)
    expect(contentHasFile([userMessage([{ type: 'tool-result', toolCallId: 't', toolName: 'x', content: [{ type: 'file', attachment: wanted }] }])])).toBe(true)
  })

  it('collectFileRefs keeps first-seen order and deduplicates by attachment id', () => {
    const a = ref({ name: 'a.docx', attachmentId: AttachmentId('sha256:' + '1'.repeat(64)) })
    const b = ref({ name: 'b.docx', attachmentId: AttachmentId('sha256:' + '2'.repeat(64)) })
    const refs = collectFileRefs([
      userMessage([{ type: 'file', attachment: a }, { type: 'file', attachment: b }]),
      userMessage([{ type: 'file', attachment: a }]),
    ])
    expect([...refs.keys()]).toEqual([a.attachmentId, b.attachmentId])
  })
})

const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'


/** A minimal but structurally valid single-page PDF whose text layer carries the given lines. */
function pdfBytes(textLines: readonly string[]): Uint8Array {
  const parts: string[] = []
  const offsets: number[] = []
  let cursor = 0
  const push = (chunk: string): void => { parts.push(chunk); cursor += chunk.length }
  const object = (id: number, body: string): void => { offsets[id] = cursor; push(id + ' 0 obj\n' + body + '\nendobj\n') }
  push('%PDF-1.4\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>')
  const escaped = textLines.map(line => line.replace(/[\\()]/g, match => '\\' + match))
  const content = escaped.map(line => 'BT /F1 14 Tf 72 700 Td (' + line + ') Tj ET').join('\n')
  object(4, '<< /Length ' + String(content.length) + " >>\nstream\n" + content + '\nendstream')
  object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const startxref = cursor
  push('xref\n0 6\n0000000000 65535 f \n')
  for (let id = 1; id <= 5; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n')
  push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + String(startxref) + '\n%%EOF\n')
  return new TextEncoder().encode(parts.join(''))
}

describe('fileBlockText', () => {
  const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  it('renders included contents inside a delimited attributed block', () => {
    const wanted = ref({ name: 'essay.docx', mediaType: DOCX_TYPE, bytes: 42 })
    const text = fileBlockText({ ref: wanted, text: 'Body line' })
    expect(text.startsWith('<attached-file name="essay.docx" media-type="' + DOCX_TYPE + '" bytes="42">')).toBe(true)
    expect(text.endsWith('\nBody line\n</attached-file>')).toBe(true)
  })

  it('marks truncation on the block attributes', () => {
    const wanted = ref({ name: 'big.txt', mediaType: 'text/plain', bytes: 9999 })
    const text = fileBlockText({ ref: wanted, text: 'part', truncated: true })
        expect(text).toContain('truncated="true"')
  })
})

describe('extractPptxText', () => {
  it('flattens slides in deck order with paragraph breaks between shapes', () => {
    const slide = (runs: readonly string[]): string => '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>'
      + runs.map(run => '<p:sp><p:txBody><a:p><a:r><a:t>' + run + '</a:t></a:r></a:p></p:txBody></p:sp>').join('')
      + '</p:spTree></p:cSld></p:sld>'
    const data = zipSync({
      'ppt/slides/slide2.xml': strToU8(slide(['Second slide point', 'tail line'])),
      'ppt/slides/slide10.xml': strToU8(slide(['Tenth after second'])),
      'ppt/slides/slide1.xml': strToU8(slide(['Deck title', 'GHG emissions by scope'])),
      'ppt/slides/_rels/slide1.xml.rels': strToU8('<Relationships/>'),
    })
    const text = extractPptxText(data)
    expect(text?.startsWith('Deck title\nGHG emissions by scope\nSecond slide point\ntail line\n')).toBe(true)
    // Natural ordering: slide10 comes after slide2, not directly after slide1.
    expect(text?.indexOf('Second slide point')).toBeLessThan(text?.indexOf('Tenth after second') ?? Number.MAX_SAFE_INTEGER)
  })

  it('returns undefined for a package without any slide part', () => {
    expect(extractPptxText(zipSync({ 'docProps/core.xml': strToU8('<x/>') }))).toBeUndefined()
  })
})

describe('extractXlsxText', () => {
  it('renders named worksheets with shared-string, numeric, and inline cells', () => {
    const data = zipSync({
      'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Grades" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<?xml version="1.0"?><sst><si><t>Alpha</t></si><si><r><t>Beta</t></r><r><t> run</t></r></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<?xml version="1.0"?><worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>Beta run</t></is></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>1</v></c></row>'
        + '</sheetData></worksheet>'),
      'xl/worksheets/sheet2.xml': strToU8('<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>'),
    })
    expect(extractXlsxText(data)).toBe('[Grades]\nAlpha\t42\tBeta run\nBeta run\n\n[Notes]\n7')
  })

  it('falls back to file names when the workbook declares no sheets', () => {
    const data = zipSync({
      'xl/worksheets/sheet3.xml': strToU8('<worksheet><sheetData><row><c><v>9</v></c></row></sheetData></worksheet>'),
    })
    expect(extractXlsxText(data)).toBe('[sheet3]\n9')
  })
})

describe('extractOdfText', () => {
  it('flattens headings, paragraphs, tabs, and whitespace elements from content.xml', () => {
    const data = zipSync({
      'content.xml': strToU8('<?xml version="1.0"?><office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">'
        + '<office:body><office:text>'
        + '<text:h>Unit Summary</text:h>'
        + '<text:p>Demand &amp; supply<text:tab/>with <text:s/>notes</text:p>'
        + '<table:table><table:table-row><table:table-cell><text:p>cell A</text:p></table:table-cell><table:table-cell><text:p>cell B</text:p></table:table-cell></table:table-row></table:table>'
        + '</office:text></office:body></office:document-content>'),
    })
    expect(extractOdfText(data)).toBe('Unit Summary\nDemand & supply\twith notes\ncell A\tcell B')
  })
})

describe('extractEpubText', () => {
  it('joins every XHTML content document in path order', () => {
    const data = zipSync({
      'META-INF/container.xml': strToU8('<container/>'),
      'OEBPS/chapter1.xhtml': strToU8('<html><body><h1>Chapter One</h1><p>Opening line.</p></body></html>'),
      'OEBPS/chapter2.xhtml': strToU8('<html><body><h1>Chapter Two</h1><p>Closing line.</p></body></html>'),
    })
    expect(extractEpubText(data)).toBe('Chapter One\nOpening line.\nChapter Two\nClosing line.')
  })
})

describe('extractPdfText', () => {
  it('extracts the text layer of a real single-page PDF through pdf.js', async () => {
    const text = await extractPdfText(pdfBytes(['Hello PDF text', 'Second line stands']))
    expect(text).toContain('Hello PDF text')
    expect(text).toContain('Second line stands')
  })

  it('degrades gracefully for bytes pdf.js cannot parse', async () => {
    await expect(extractPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]))).resolves.toBeUndefined()
  })
})

describe('structured-kind dispatch', () => {
  it('routes a pptx attachment through its extractor inside prepareRequestFiles', async () => {
    const deckRef = ref({ name: 'deck-notes.pptx', mediaType: PPTX_TYPE, attachmentId: AttachmentId('sha256:' + '3'.repeat(64)) })
    const stored: StoredFileAttachment = { ref: deckRef, data: zipSync({
      'ppt/slides/slide1.xml': strToU8('<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Scope 3 totals</a:t></a:r></a:p></p:sld>'),
    }) }
    const prepared = await prepareRequestFiles([deckRef], storeWith([stored]), 100_000)
    expect(prepared.get(deckRef.attachmentId)).toMatchObject({ text: 'Scope 3 totals' })
  })
})
