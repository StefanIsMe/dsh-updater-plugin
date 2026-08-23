/** Client-side attachment-kind classification shared by the picker and drop intake paths. */

/** Image media types the durable image path accepts; the byte-sniff fallback trusts this declared list. */
const ACCEPTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Detect an accepted raster signature in a file's leading bytes. Browser MIME
 * labels are untrusted (renamed files, empty types on some drops), so intake
 * routing classifies by content first and only then trusts the declaration.
 * @param file - the browser file (or blob) to probe; at most 12 leading bytes are read.
 * @returns whether the leading bytes match an accepted raster signature.
 */
export async function sniffsAsImage(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true
  // JPEG: FF D8 FF
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true
  // GIF: 'GIF8'
  if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return true
  // WebP: 'RIFF' .... 'WEBP'
  if (head.length >= 12
    && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return true
  return false
}

/** Both routed groups of one intake batch, each preserving submission order. */
export interface SplitImageFiles {
  /** Raster-signature (or accepted-declared) files for the model-visible image pipeline. */
  readonly images: File[]
  /** Everything else, for the card-only generic-file pipeline. */
  readonly others: File[]
}

/**
 * Split one picked-or-dropped batch into the durable image pipeline and the
 * generic-file pipeline. A real raster stays model-visible even when its
 * browser-declared type is wrong or empty, while declared-image bytes without
 * any raster signature ride the honest card-only path instead of failing
 * image admission after upload.
 * @param files - the batch in submission order.
 * @returns both routed groups, each preserving input order.
 */
export async function splitImageFiles(files: readonly File[]): Promise<SplitImageFiles> {
  const images: File[] = []
  const others: File[] = []
  for (const file of files) {
    if (await sniffsAsImage(file) || ACCEPTED_IMAGE_MIME_TYPES.has(file.type)) images.push(file)
    else others.push(file)
  }
  return { images, others }
}
