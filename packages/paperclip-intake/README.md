# Paperclip Intake

The composer's file-picker routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — how a picked file decides between the **model-visible image pipeline** and the **durable generic-file pipeline** whose extracted text reaches any LLM API endpoint.

## `src/attachment-kind.ts`

Self-contained classifier shared by the picker and drag-drop intake paths. `splitImageFiles(files)` probes leading bytes for accepted raster signatures (PNG / JPEG / GIF / WebP) first and only then trusts the browser's MIME declaration, so a renamed image still lands on the vision path while declared-image bytes without a raster signature ride the honest file path instead of failing admission after upload.

Byte-for-byte mirror of `packages/client/ui-conversation/src/client/attachment-kind.ts` in the harness monorepo.

## How the composer consumes it

In the full harness (`ui-conversation`'s `InputBar.tsx`, not mirrored here — it is entangled with the conversation machine):

```ts
void splitImageFiles(Array.from(picked)).then(({ images, others }) => {
  if (images.length > 0) intakeImages(images)   // model-visible image pipeline
  if (others.length > 0) intakeFiles(others)     // durable card → text extraction at request time
})
```

Generic files are admitted durably (content-addressed bytes + digest verification), rendered as download cards in the transcript, and — via [`packages/llm-pi-ai`](../llm-pi-ai/) — projected into provider requests as extracted text. See [docs/paperclip-file-pipeline.md](../../docs/paperclip-file-pipeline.md) for the whole journey.
