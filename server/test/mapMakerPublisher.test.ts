import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishMapModel, publishMapToGame } from "../src/mapMakerPublisher.ts";

test("publishes map code and its GLB into the game project", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mechfall-map-publish-"));
  try {
    await mkdir(path.join(workspace, "shared", "src", "game"), { recursive: true });
    const model = Buffer.from("glTF-test-model");
    const publishedModel = await publishMapModel(workspace, "Garage Run", "car.glb", model);
    const result = await publishMapToGame(workspace, {
      mapName: "Garage Run",
      worldSize: 48,
      floorColor: "#112233",
      borderColor: "#445566",
      boxes: [{ id: "wall", position: [0, 2, -24], size: [48, 4, 1], color: "#445566", kind: "wall", solid: true }],
      hulls: [{
        id: "car-collision",
        vertices: [[0, 0, 0], [2, 0, 0], [0, 1, 0], [0, 0, 2]],
        triangles: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
        color: "#57b9a9",
        kind: "hull",
        solid: true,
        visible: false
      }],
      model: {
        url: publishedModel.url,
        transform: { position: [3, 0, 4], rotation: [0, 1.57, 0], scale: [0.5, 0.5, 0.5] }
      }
    });

    const source = await readFile(result.mapCodePath, "utf8");
    assert.match(source, /GENERATED_WORLD_NAME = "Garage Run"/);
    assert.match(source, /GENERATED_WORLD_SIZE = 48/);
    assert.match(source, /"visible": false/);
    assert.match(result.mapCodePath, /shared[\\/]src[\\/]game[\\/]maps[\\/]garage-run\.ts$/);
    assert.match(await readFile(path.join(workspace, "shared", "src", "game", "generatedWorld.ts"), "utf8"), /\.\/maps\/garage-run\.ts/);
    assert.deepEqual(await readFile(publishedModel.modelPath), model);
    assert.match(publishedModel.modelPath, /client[\\/]public[\\/]models[\\/]maps[\\/]garage-run\.glb$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects unsafe or malformed map payloads", async () => {
  await assert.rejects(() => publishMapToGame("C:/unused", {
    mapName: "Bad Map",
    worldSize: 42,
    floorColor: "not-a-color",
    borderColor: "#ffffff",
    boxes: [],
    hulls: []
  }), /floor color/);
});
