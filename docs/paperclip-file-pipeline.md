# Paperclip File Pipeline — sending documents to any LLM API

Every non-image file attached through the DSH composer's paperclip reaches your model's API endpoint with its **contents**, not just its name. This doc describes the journey and the code that implements it in this repo ([`packages/llm-pi-ai`](../packages/llm-pi-ai/) + [`packages/paperclip-intake`](../packages/paperclip-intake/)).

## The journey

```
paperclip pick / drag-drop
        │
        ▼
[1] splitImageFiles()            attachment-kind.ts — magic-byte-first classification
        │ images (png/jpeg/webp/gif)          → vision pipeline (native image parts)
        └ others (docx/pdf/xlsx/md/…)         → generic-file pipeline
        ▼
[2] durable admission             AttachmentStore.saveFile — content-addressed bytes,
        │                          digest verification, per-message/session limits
        ▼
[3] durable transcript            download cards render from the stored reference;
        │                          the file survives restarts and session replay
        ▼
[4] request-time projection       llm-pi-ai/file-request.ts reads the stored bytes and
        │                          extracts text per family (below), under a budget
        ▼
[5] provider request              <attached-file …> blocks ride every wire the
                                   pi-ai adapter serves (chat completions, responses, …)
```

## Extraction families (`src/file-request.ts`)

| Family | Formats | How |
|---|---|---|
| Word processing | `.docx` | unzip `word/document.xml`; ordered `<w:t>` run scan; paragraph/table boundaries → breaks/tabs; XML entities unescaped |
| Presentations | `.pptx` | `ppt/slides/slideN.xml` in natural deck order; `<a:t>` runs; speaker notes excluded |
| Spreadsheets | `.xlsx` | `xl/sharedStrings.xml` + named worksheets via workbook relationships; `[SheetName]` sections; shared/inline/formula/numeric cells |
| OpenDocument | `.odt/.ods/.odp/.odg` | `content.xml` boundary marking (headings, paragraphs, table rows/cells) |
| EPUB | `.epub` | every XHTML member in path order, block tags → line breaks |
| PDF | `.pdf` | pdf.js text layer page-by-page via `unpdf`; image-only scans degrade gracefully |
| Plain text | `.txt .md .csv .json .yaml .xml .html` + ~40 code extensions, any `text/*` MIME | UTF-8 decode (BOM stripped); replacement-char dominance ⇒ binary |
| Anything else | `.zip`, legacy OLE `.doc/.xls/.ppt`, … | degrades to the historical name-only note — never fails the request |

Detection is media-type-first, filename-extension-second: browser MIME labels are best-effort.

## The wire format

Included files render inside one delimited text block per attachment:

```
<attached-file name="report.docx" media-type="application/vnd.openxmlformats-officedocument.wordprocessingml.document" bytes="9985">
Essay body paragraph one.
Paragraph two cites a source.
</attached-file>
```

A file that cannot be represented keeps the historical note:

```
[Attached file: archive.zip (application/zip, 10 bytes) - contents not included in this request.]
```

`truncated="true"` marks a block cut short by the request budget.

## Budget: `maxRequestFileTextChars`

Extracted text shares a **per-request character budget** (default `200_000`, ≈50k tokens of headroom). Spend order is message order; a file that does not fit is truncated mid-text (flagged) and later files degrade to notes. Configure per provider route:

```yaml
llm-pi-ai:
  providers:
    opencodezen-chat:
      # …endpoint/model config…
      maxRequestFileTextChars: 200000   # raise for 1M-context models if your gateway allows
```

The knob validates like every profile field (`positive safe integer`) and hot-reloads without a restart.

## Verified live (2026-08-23)

Every supported family was exercised end-to-end against a real OpenCode Zen endpoint (`https://opencode.ai/zen/v1`, chat completions) with representative documents; each model answered questions that are only answerable from the extracted contents:

| Attached file | Bytes | Model answer quality | Input tokens |
|---|---|---|---|
| word-processing `.docx` | 9,985 | title + thesis statement quoted back verbatim | 1,145 |
| markdown `.md` | 3,406 | confirmed markdown headings + topic summary | 797 |
| plain-text `.txt` | 3,352 | topic extracted in one line | 762 |
| proposal `.pdf` | 119,436 | named the business + campaign goal | 1,951 |
| workbook `.xlsx` | 12,210 | sheet name + journal/trial-balance content | 1,134 |
| slide deck `.pptx` | 209,791 | deck title + topic | 1,696 |

Token counts confirm the extracted body rode each request — a name-only note would cost single digits.

## Tests

`packages/llm-pi-ai/tests/file-request.spec.ts` builds structurally real fixtures for every family (including a hand-assembled valid PDF with a computed xref table) and covers extraction, degradation reasons (`read-failed` / `binary` / `budget`), truncation flags, and history predicates. Run them inside a harness checkout where workspace deps resolve — this plugin mirror is byte-parity source, not a standalone build (see CONTRIBUTING).
