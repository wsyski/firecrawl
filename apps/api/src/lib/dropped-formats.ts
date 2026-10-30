import { Document, FormatObject } from "../controllers/v2/types";

export type FormatType = FormatObject["type"];

// Which Document field(s) each requested format is supposed to populate. A
// format whose fields are all still absent once the transformer stack has run
// was asked for but not produced — a `success: true` response that silently
// lacks what the caller requested.
//
// "Absent" means null as well as undefined: a failed extraction assigns
// `document.json = extractedData ?? null` on purpose (see performLLMExtract),
// which is the local model's failure shape and the case this field exists for.
const FORMAT_FIELDS: Record<FormatType, (keyof Document)[]> = {
  markdown: ["markdown"],
  html: ["html"],
  rawHtml: ["rawHtml"],
  rawBase64: ["rawBase64"],
  links: ["links"],
  images: ["images"],
  summary: ["summary"],
  // Both populate document.json; the v1 compatibility path keeps it in extract.
  json: ["json", "extract"],
  deterministicJson: ["json", "extract"],
  changeTracking: ["changeTracking"],
  screenshot: ["screenshot"],
  attributes: ["attributes"],
  // question and its legacy alias query both answer into document.answer.
  question: ["answer"],
  query: ["answer"],
  highlights: ["highlights"],
  branding: ["branding"],
  product: ["product"],
  menu: ["menu"],
  audio: ["audio"],
  video: ["video", "videos"],
};

export function findDroppedFormats(
  formats: FormatObject[] | undefined,
  document: Document,
): FormatType[] {
  const dropped = (formats ?? [])
    .map(format => format.type)
    .filter(type =>
      FORMAT_FIELDS[type].every(field => document[field] == null),
    );
  return [...new Set(dropped)];
}

export function addDroppedFormats(
  document: Document,
  ...formats: FormatType[]
): void {
  const merged = new Set([...(document.droppedFormats ?? []), ...formats]);
  if (merged.size > 0) {
    document.droppedFormats = [...merged];
  }
}
