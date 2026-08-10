import {
  GENERATED_BORDER_COLOR,
  GENERATED_FLOOR_COLOR,
  GENERATED_WORLD_BOXES,
  GENERATED_WORLD_HULLS,
  GENERATED_WORLD_MODEL,
  GENERATED_WORLD_NAME,
  GENERATED_WORLD_SIZE
} from "./generatedWorld.ts";

export interface WorldBox {
  id: string;
  position: readonly [number, number, number];
  size: readonly [number, number, number];
  color: string;
  kind: "wall" | "crate" | "table" | "column" | "planter";
  solid: boolean;
}

/** A 3D collision mesh. Vertices are world-space and triangles index them. */
export interface WorldHull {
  id: string;
  vertices: readonly (readonly [number, number, number])[];
  triangles?: readonly (readonly [number, number, number])[];
  color: string;
  kind: "hull";
  solid: boolean;
  /** False for collision supplied by a visible imported map model. */
  visible?: boolean;
}

export interface WorldModel {
  url: string;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
}

export interface HullFootprint {
  points: readonly (readonly [number, number])[];
  minY: number;
  maxY: number;
}

export const WORLD_NAME = GENERATED_WORLD_NAME;
export const WORLD_SIZE = GENERATED_WORLD_SIZE;
export const WORLD_WALL_THICKNESS = 1;
export const WORLD_FLOOR_COLOR = GENERATED_FLOOR_COLOR;
export const WORLD_BORDER_COLOR = GENERATED_BORDER_COLOR;
export const WORLD_MODEL = GENERATED_WORLD_MODEL;
export const WORLD_BOXES: readonly WorldBox[] = GENERATED_WORLD_BOXES;
export const WORLD_HULLS: readonly WorldHull[] = GENERATED_WORLD_HULLS;

export function worldHullFootprint(hull: WorldHull): HullFootprint {
  return {
    points: convexHull2D(hull.vertices.map((vertex) => [vertex[0], vertex[2]])),
    minY: Math.min(...hull.vertices.map((vertex) => vertex[1])),
    maxY: Math.max(...hull.vertices.map((vertex) => vertex[1]))
  };
}

/** Highest triangle-mesh surface at an X/Z point, or undefined outside the mesh projection. */
export function worldHullHeightAt(hull: WorldHull, x: number, z: number): number | undefined {
  if (!hull.triangles?.length) return undefined;
  let highest = -Infinity;
  for (const triangle of hull.triangles) {
    const a = hull.vertices[triangle[0]];
    const b = hull.vertices[triangle[1]];
    const c = hull.vertices[triangle[2]];
    if (!a || !b || !c) continue;
    const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(denominator) < 1e-9) continue;
    const first = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
    const second = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
    const third = 1 - first - second;
    if (first < -1e-6 || second < -1e-6 || third < -1e-6) continue;
    highest = Math.max(highest, first * a[1] + second * b[1] + third * c[1]);
  }
  return highest > -Infinity ? highest : undefined;
}

/** Monotone-chain hull. Returned points are counter-clockwise. */
export function convexHull2D(input: readonly (readonly [number, number])[]): [number, number][] {
  const points = [...new Map(input.map((point) => [`${point[0]},${point[1]}`, [point[0], point[1]] as [number, number]])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (points.length <= 2) return points;
  const cross = (origin: readonly number[], a: readonly number[], b: readonly number[]): number =>
    (a[0]! - origin[0]!) * (b[1]! - origin[1]!) - (a[1]! - origin[1]!) * (b[0]! - origin[0]!);
  const lower: [number, number][] = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: [number, number][] = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

const spawnEdge = Math.max(2, WORLD_SIZE / 2 - 4);
const spawnMiddle = Math.max(1.5, Math.min(8, spawnEdge / 2));
export const SPAWN_POINTS: readonly (readonly [number, number, number])[] = [
  [-spawnEdge, 0, -spawnEdge], [spawnEdge, 0, spawnEdge], [-spawnEdge, 0, spawnEdge], [spawnEdge, 0, -spawnEdge],
  [0, 0, -spawnEdge], [0, 0, spawnEdge], [-spawnEdge, 0, 0], [spawnEdge, 0, 0],
  [-spawnMiddle, 0, spawnMiddle], [spawnMiddle, 0, -spawnMiddle], [-spawnMiddle, 0, -spawnMiddle], [spawnMiddle, 0, spawnMiddle]
];
