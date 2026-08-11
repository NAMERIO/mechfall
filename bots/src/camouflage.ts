import { MAX_PAINT_STROKES_PER_PACKET, type PaintPart, type PaintStroke } from "@mechfall/shared";

const PARTS: readonly PaintPart[] = ["body", "head", "leftArm", "rightArm", "leftLeg", "rightLeg"];

/** Covers every body texture with overlapping, server-valid paint dabs. */
export function camouflageBatches(color: string, actionId: string): PaintStroke[][] {
  const strokes: PaintStroke[] = [];
  for (const part of PARTS) for (let row = 0; row < 5; row += 1) for (let column = 0; column < 5; column += 1) {
    strokes.push({
      part,
      u: 0.1 + column * 0.2,
      v: 0.1 + row * 0.2,
      color,
      size: 0.22,
      actionId
    });
  }
  const batches: PaintStroke[][] = [];
  for (let index = 0; index < strokes.length; index += MAX_PAINT_STROKES_PER_PACKET) {
    batches.push(strokes.slice(index, index + MAX_PAINT_STROKES_PER_PACKET));
  }
  return batches;
}
