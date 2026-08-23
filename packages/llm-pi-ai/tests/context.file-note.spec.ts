/** Generic-file references stay model-visible in both conversion paths — as extracted contents when resolvable, name-only notes otherwise. */

import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'

const FILE_REF: FileAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'text/plain',
  bytes: 15,
  name: 'notes.txt',
}

/** Byte resolution is never reached in this spec: only file blocks ride through. */
const STORE = {
  readImage: () => Promise.reject(new Error('no images in this spec')),
} as unknown as AttachmentStore

function options(content: readonly unknown[]): GenerateOptions {
  return {
    provider: 'openai',
    model: 'gpt-test',
    messages: [createUserMessage({ content: content as never, source: { kind: 'user' } })],
  } as unknown as GenerateOptions
}

function joined(context: { messages: readonly { content: unknown }[] }): string {
  const content = context.messages[0]?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part === 'object' && part !== null && 'text' in part
    ? String((part as { text?: unknown }).text ?? '')
    : '').join('\n')
}

describe('generic-file projection into provider context', () => {
  it('projects a durable file reference as a textual note when images resolve', async () => {
    const context = await toPiContext(options([
      { type: 'file', attachment: FILE_REF },
      { type: 'text', text: 'see attachment' },
    ]), STORE)
    const text = joined(context)
    expect(text).toContain('[Attached file: notes.txt (text/plain, 15 bytes)')
    expect(text).toContain('contents not included in this request')
    expect(text).toContain('see attachment')
  })

  it('projects the same note without the attachment service (text-only path)', () => {
    const context = toPiContext(options([
      { type: 'file', attachment: FILE_REF },
      { type: 'text', text: 'plain path' },
    ]))
    const text = joined(context)
    expect(text).toContain('[Attached file: notes.txt (text/plain, 15 bytes)')
    expect(text).toContain('plain path')
  })

  it('rides a resolvable plain-text attachment into the request as delimited contents', async () => {
    const store = {
      readImage: () => Promise.reject(new Error('no images in this spec')),
      readFile: () => Promise.resolve({
        ref: FILE_REF,
        data: new TextEncoder().encode('first line of notes'),
      }),
    } as unknown as AttachmentStore
    const context = await toPiContext(options([
      { type: 'file', attachment: FILE_REF },
      { type: 'text', text: 'see attachment' },
    ]), store)
    const text = joined(context)
    expect(text).toContain('<attached-file name="notes.txt" media-type="text/plain" bytes="15">')
    expect(text).toContain('first line of notes')
    expect(text).toContain('</attached-file>')
    expect(text).not.toContain('contents not included')
  })

  it('extracts an attached .docx into the request so its body text reaches the model', async () => {
    const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const docxRef: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
      mediaType: DOCX_TYPE,
      bytes: 99,
      name: 'report.docx',
    }
    const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:t>Essay body paragraph one.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Paragraph two cites a source.</w:t></w:r></w:p>'
      + '</w:body></w:document>'
    const store = {
      readImage: () => Promise.reject(new Error('no images in this spec')),
      readFile: () => Promise.resolve({ ref: docxRef, data: zipSync({ 'word/document.xml': strToU8(document) }) }),
    } as unknown as AttachmentStore
    const context = await toPiContext(options([
      { type: 'file', attachment: docxRef },
      { type: 'text', text: 'review my essay' },
    ]), store)
    const text = joined(context)
    expect(text).toContain('<attached-file name="report.docx"')
    expect(text).toContain('Essay body paragraph one.')
    expect(text).toContain('Paragraph two cites a source.')
    expect(text).toContain('review my essay')
  })
})
