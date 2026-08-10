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
}

export interface HullFootprint {
  points: readonly (readonly [number, number])[];
  minY: number;
  maxY: number;
}

export const WORLD_SIZE = 42;
export const WORLD_WALL_THICKNESS = 1;

export const WORLD_BOXES: readonly WorldBox[] = [
  { id: "north", position: [0, 2.5, -21], size: [43, 5, WORLD_WALL_THICKNESS], color: "#de704e", kind: "wall", solid: true },
  { id: "south", position: [0, 2.5, 21], size: [43, 5, WORLD_WALL_THICKNESS], color: "#50a89b", kind: "wall", solid: true },
  { id: "west", position: [-21, 2.5, 0], size: [WORLD_WALL_THICKNESS, 5, 43], color: "#e9b949", kind: "wall", solid: true },
  { id: "east", position: [21, 2.5, 0], size: [WORLD_WALL_THICKNESS, 5, 43], color: "#466c99", kind: "wall", solid: true },
  { id: "center-red", position: [-4.5, 1.5, -1], size: [5, 3, 2], color: "#d9564a", kind: "crate", solid: true },
  { id: "center-blue", position: [3.5, 1, 2], size: [3, 2, 4], color: "#4778a8", kind: "crate", solid: true },
  { id: "yellow-stack-a", position: [11, 1, -10], size: [4, 2, 3], color: "#e7b844", kind: "crate", solid: true },
  { id: "yellow-stack-b", position: [11.5, 3, -10], size: [2.5, 2, 2.5], color: "#e7b844", kind: "crate", solid: true },
  { id: "teal-table", position: [-12, 1.35, 9], size: [6, 0.65, 3], color: "#4a9d91", kind: "table", solid: true },
  { id: "teal-leg-a", position: [-14.2, 0.65, 8], size: [0.5, 1.3, 0.5], color: "#34766e", kind: "table", solid: true },
  { id: "teal-leg-b", position: [-9.8, 0.65, 10], size: [0.5, 1.3, 0.5], color: "#34766e", kind: "table", solid: true },
  { id: "purple-column", position: [-13, 2.4, -10], size: [2.4, 4.8, 2.4], color: "#8067a8", kind: "column", solid: true },
  { id: "orange-column", position: [14, 2.4, 9], size: [2.4, 4.8, 2.4], color: "#d97843", kind: "column", solid: true },
  { id: "green-planter", position: [1, 0.75, 13], size: [6, 1.5, 2.5], color: "#658f55", kind: "planter", solid: true },
  { id: "pink-bench", position: [-2, 0.65, -13], size: [7, 1.3, 1.7], color: "#c86886", kind: "table", solid: true },
  { id: "blue-long", position: [14, 1.25, 0], size: [2.5, 2.5, 7], color: "#506f9c", kind: "crate", solid: true }
] as const;

/** Smooth collision hulls exported by the map maker belong here. */
export const WORLD_HULLS: readonly WorldHull[] = [] as const;

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

export const SPAWN_POINTS: readonly (readonly [number, number, number])[] = [
  [-17, 0, -16], [17, 0, 16], [-17, 0, 16], [17, 0, -16],
  [0, 0, -17], [0, 0, 17], [-17, 0, 0], [17, 0, 0],
  [-8, 0, 5], [8, 0, -5], [-8, 0, -5], [8, 0, 5]
];
