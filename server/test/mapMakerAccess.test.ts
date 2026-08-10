import assert from "node:assert/strict";
import test from "node:test";
import { isLocalMapMakerRequest, isMapMakerPublishingRuntime } from "../src/mapMakerAccess.ts";

test("map publishing is registered only from unbuilt development source", () => {
  const sourceUrl = new URL("../src/index.ts", import.meta.url).href;
  const builtUrl = new URL("../dist/index.js", import.meta.url).href;
  assert.equal(isMapMakerPublishingRuntime(sourceUrl, undefined), true);
  assert.equal(isMapMakerPublishingRuntime(sourceUrl, "development"), true);
  assert.equal(isMapMakerPublishingRuntime(sourceUrl, "production"), false);
  assert.equal(isMapMakerPublishingRuntime(builtUrl, undefined), false);
  assert.equal(isMapMakerPublishingRuntime(builtUrl, "development"), false);
});

test("map publishing accepts only loopback requests and loopback proxy chains", () => {
  assert.equal(isLocalMapMakerRequest("127.0.0.1", undefined), true);
  assert.equal(isLocalMapMakerRequest("::1", "127.0.0.1"), true);
  assert.equal(isLocalMapMakerRequest("::ffff:127.0.0.1", "::1, 127.0.0.1"), true);
  assert.equal(isLocalMapMakerRequest("192.168.1.20", undefined), false);
  assert.equal(isLocalMapMakerRequest("127.0.0.1", "192.168.1.20"), false);
  assert.equal(isLocalMapMakerRequest("127.0.0.1", "127.0.0.1, 10.0.0.8"), false);
});
