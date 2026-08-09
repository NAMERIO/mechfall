import type { ServerSnapshot } from "@mechfall/shared";
import { WorldRenderer } from "../game/WorldRenderer.ts";

declare global {
  interface Window {
    __paintTestResult?: PaintTestResult;
    __continuePaintTest?: boolean;
  }
}

interface PaintTestResult {
  brushMs: number;
  localStrokeCoverage: number;
  shoulderCoverage: number;
  lineMs: number;
  lineCoverage: number;
  wholeBodyCoverage: number;
  strokes: number;
  passed: boolean;
}

const PAINT_COLOR = "#20c997";
const container = document.createElement("main");
const status = document.createElement("pre");
container.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#b8c4ba";
status.style.cssText = "position:fixed;left:12px;top:12px;z-index:5;margin:0;padding:9px 12px;background:#111c;color:#fff;font:13px monospace";
status.textContent = "Loading the real character model…";
document.body.replaceChildren(container, status);

const world = new WorldRenderer(container);
const snapshot: ServerSnapshot = {
  type: "snapshot",
  serverTime: Date.now(),
  sequence: 1,
  selfId: "paint-test-player",
  gameId: "TEST",
  ownerId: "paint-test-player",
  players: [{
    id: "paint-test-player",
    name: "Paint Test",
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    role: "hider",
    pose: "stand",
    color: "#f5f0df",
    alive: true,
    score: 0,
    tags: 0,
    whistlingUntil: 0
  }],
  round: { phase: "hiding", endsAt: Date.now() + 60_000, round: 1 }
};
world.applySnapshot(snapshot);
world.setPaintView(true);

void runPaintTest();

async function runPaintTest(): Promise<void> {
  await world.waitForCharacterModel();
  await waitForFrames(40);

  const firstPoint = findAndPaintFirstVisiblePoint(0.12, 0.5, 0.5);
  const brushMs = firstPoint?.paintMs ?? Number.POSITIVE_INFINITY;
  const localStrokeCoverage = world.measureSelfPaintCoverage(PAINT_COLOR).ratio;
  status.textContent = [
    "CIRCULAR BRUSH DAB",
    `stamp time: ${brushMs.toFixed(1)}ms`,
    `painted: ${(localStrokeCoverage * 100).toFixed(2)}% of body`,
    "checking for distant bleed…"
  ].join("\n");
  document.body.dataset.paintTestStage = "circle";
  await waitForTestContinuation();
  world.resetPaint(snapshot.selfId);

  window.__continuePaintTest = false;
  const shoulderStrokes = firstPoint
    ? world.paintBrushAtScreen(firstPoint.x - 34, firstPoint.y - 28, PAINT_COLOR, 0.07)
    : [];
  const shoulderCoverage = world.measureSelfPaintCoverage(PAINT_COLOR).ratio;
  status.textContent = [
    "SHOULDER EDGE DAB",
    `painted: ${(shoulderCoverage * 100).toFixed(2)}% of body`,
    "checking nearby limbs for bleedâ€¦"
  ].join("\n");
  document.body.dataset.paintTestStage = "shoulder";
  await waitForTestContinuation();
  world.resetPaint(snapshot.selfId);

  window.__continuePaintTest = false;
  const lineStartedAt = performance.now();
  if (firstPoint) {
    world.paintBrushLineAtScreen(firstPoint.x - 42, firstPoint.y, firstPoint.x + 42, firstPoint.y, PAINT_COLOR, 0.12);
  }
  const lineMs = performance.now() - lineStartedAt;
  const lineCoverage = world.measureSelfPaintCoverage(PAINT_COLOR).ratio;
  status.textContent = [
    "SMOOTH BRUSH LINE",
    `segment time: ${lineMs.toFixed(1)}ms`,
    `painted: ${(lineCoverage * 100).toFixed(2)}% of body`,
    "checking continuity…"
  ].join("\n");
  document.body.dataset.paintTestStage = "line";
  await waitForTestContinuation();
  world.resetPaint(snapshot.selfId);

  const strokes = world.paintEverySelfFaceForTest(PAINT_COLOR, 0.035);
  await waitForFrames(20);

  const wholeBodyCoverage = world.measureSelfPaintCoverage(PAINT_COLOR).ratio;
  const passed = Boolean(firstPoint)
    && localStrokeCoverage > 0
    && localStrokeCoverage < 0.05
    && brushMs < 20
    && shoulderStrokes.length > 0
    && shoulderCoverage > 0
    && shoulderCoverage < 0.05
    && lineMs < 20
    && lineCoverage > localStrokeCoverage
    && lineCoverage < 0.16
    && wholeBodyCoverage === 1;
  const result: PaintTestResult = { brushMs, localStrokeCoverage, shoulderCoverage, lineMs, lineCoverage, wholeBodyCoverage, strokes, passed };
  window.__paintTestResult = result;
  document.body.dataset.paintTest = passed ? "passed" : "failed";
  status.textContent = [
    passed ? "PAINT TEST PASSED" : "PAINT TEST FAILED",
    `one dab: ${(localStrokeCoverage * 100).toFixed(2)}% of body`,
    `whole body: ${(wholeBodyCoverage * 100).toFixed(2)}% covered`,
    `faces tested: ${strokes}`
  ].join("\n");
}

function findAndPaintFirstVisiblePoint(
  size: number,
  xRatio: number,
  yRatio: number
): { x: number; y: number; paintMs: number } | undefined {
  const bounds = world.canvas.getBoundingClientRect();
  const centerX = bounds.left + bounds.width * xRatio;
  const centerY = bounds.top + bounds.height * yRatio;
  for (let radius = 0; radius < Math.min(bounds.width, bounds.height) * 0.35; radius += 8) {
    const samples = Math.max(1, Math.ceil(radius / 6));
    for (let sample = 0; sample < samples; sample += 1) {
      const angle = (sample / samples) * Math.PI * 2;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      const strokes = world.paintBrushAtScreen(x, y, PAINT_COLOR, size);
      if (strokes.length > 0) {
        const warmedStartedAt = performance.now();
        world.paintBrushAtScreen(x, y, PAINT_COLOR, size);
        return { x, y, paintMs: performance.now() - warmedStartedAt };
      }
    }
  }
  return undefined;
}

function waitForTestContinuation(): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const poll = (): void => {
      if (window.__continuePaintTest || performance.now() - startedAt > 5_000) resolve();
      else window.setTimeout(poll, 25);
    };
    poll();
  });
}

function waitForFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
