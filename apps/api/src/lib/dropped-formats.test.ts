import { Document, FormatObject } from "../controllers/v2/types";
import { addDroppedFormats, findDroppedFormats } from "./dropped-formats";

const doc = (fields: Partial<Document> = {}): Document =>
  ({ metadata: { statusCode: 200 }, ...fields }) as Document;

describe("findDroppedFormats", () => {
  it("reports nothing when every requested format is present", () => {
    expect(
      findDroppedFormats(
        [{ type: "markdown" }, { type: "links" }],
        doc({ markdown: "# hi", links: [] }),
      ),
    ).toEqual([]);
  });

  it("reports a requested format whose field is absent", () => {
    expect(
      findDroppedFormats(
        [{ type: "markdown" }, { type: "summary" }],
        doc({ markdown: "# hi" }),
      ),
    ).toEqual(["summary"]);
  });

  it("ignores a field the caller did not request", () => {
    expect(
      findDroppedFormats([{ type: "markdown" }], doc({ markdown: "x" })),
    ).toEqual([]);
  });

  it("accepts the v1 extract field for the json format", () => {
    expect(
      findDroppedFormats(
        [
          {
            type: "json",
            schema: undefined,
            prompt: undefined,
          } as FormatObject,
        ],
        doc({ extract: { a: 1 } }),
      ),
    ).toEqual([]);
  });

  it("accepts either video field for the video format", () => {
    expect(
      findDroppedFormats([{ type: "video" }], doc({ videos: [] })),
    ).toEqual([]);
    expect(findDroppedFormats([{ type: "video" }], doc())).toEqual(["video"]);
  });

  it("treats question and query as the same answer field", () => {
    expect(
      findDroppedFormats(
        [{ type: "question", question: "q" } as FormatObject],
        doc({ answer: "a" }),
      ),
    ).toEqual([]);
    expect(
      findDroppedFormats(
        [{ type: "query", prompt: "q", mode: "freeform" } as FormatObject],
        doc(),
      ),
    ).toEqual(["query"]);
  });

  it("reports each dropped format once", () => {
    expect(
      findDroppedFormats(
        [
          {
            type: "json",
            schema: undefined,
            prompt: undefined,
          } as FormatObject,
          { type: "deterministicJson" } as FormatObject,
        ],
        doc(),
      ),
    ).toEqual(["json", "deterministicJson"]);
  });

  it("reports nothing for an empty formats list", () => {
    expect(findDroppedFormats([], doc())).toEqual([]);
    expect(findDroppedFormats(undefined, doc())).toEqual([]);
  });

  it("counts a null field as dropped, which is the LLM failure shape", () => {
    // performLLMExtract assigns `extractedData ?? null` when extraction
    // produced nothing, so json/extract arrive as null rather than absent.
    expect(
      findDroppedFormats(
        [
          {
            type: "json",
            schema: undefined,
            prompt: undefined,
          } as FormatObject,
        ],
        doc({ json: null }),
      ),
    ).toEqual(["json"]);
    expect(
      findDroppedFormats(
        [
          {
            type: "json",
            schema: undefined,
            prompt: undefined,
          } as FormatObject,
        ],
        doc({ json: { title: "x" } }),
      ),
    ).toEqual([]);
  });

  it("counts an empty string or array as produced", () => {
    expect(
      findDroppedFormats(
        [{ type: "markdown" }, { type: "links" }],
        doc({ markdown: "", links: [] }),
      ),
    ).toEqual([]);
  });
});

describe("addDroppedFormats", () => {
  it("leaves the field absent when nothing is added", () => {
    const d = doc();
    addDroppedFormats(d);
    expect(d.droppedFormats).toBeUndefined();
  });

  it("merges without duplicating", () => {
    const d = doc({ droppedFormats: ["summary"] });
    addDroppedFormats(d, "branding", "summary");
    expect(d.droppedFormats!.slice().sort()).toEqual(["branding", "summary"]);
  });
});
