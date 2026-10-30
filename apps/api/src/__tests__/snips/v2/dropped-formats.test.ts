import {
  describeIf,
  HAS_FIRE_ENGINE,
  itIf,
  scrapeTimeout,
  TEST_SELF_HOST,
} from "../lib";
import { scrape, scrapeRaw, Identity, idmux } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "dropped-formats",
    concurrency: 10,
    credits: 1000000,
  });
}, 10000);

describe("dropped formats", () => {
  it(
    "says nothing when every requested format was produced",
    async () => {
      const doc = await scrape(
        { url: "https://firecrawl.dev", formats: ["markdown", "links"] },
        identity,
      );
      expect(doc.markdown).toBeDefined();
      expect(doc.links).toBeDefined();
      expect(doc.droppedFormats).toBeUndefined();
    },
    scrapeTimeout,
  );

  // Without fire engine no engine here can take a screenshot, so the scrape
  // succeeds with the screenshot field simply absent — the silent-success
  // shape this field exists to make detectable.
  itIf(TEST_SELF_HOST && !HAS_FIRE_ENGINE)(
    "names a format the engine could not produce",
    async () => {
      const raw = await scrapeRaw(
        { url: "https://firecrawl.dev", formats: ["markdown", "screenshot"] },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      expect(raw.body.success).toBe(true);
      const doc = raw.body.data;
      // Still a success carrying the formats that did work.
      expect(doc.markdown).toBeDefined();
      expect(doc.screenshot).toBeUndefined();
      // ... and the drop is now addressable without parsing prose.
      expect(doc.droppedFormats).toContain("screenshot");
      expect(doc.warning).toContain("screenshot");
    },
    scrapeTimeout,
  );
});

// A rejected format is a different case from a dropped one: it must stay an
// error rather than becoming a droppedFormats entry.
describeIf(TEST_SELF_HOST)("unknown formats", () => {
  it(
    "rejects a format that does not exist instead of dropping it",
    async () => {
      const raw = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "notaformat"],
        } as any,
        identity,
      );
      expect(raw.statusCode).not.toBe(200);
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
