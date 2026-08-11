import { readFileSync } from "node:fs";
import { WORLD_FLOOR_COLOR, WORLD_MODELS, WORLD_SIZE, type Vec3 } from "@mechfall/shared";

export interface NavPoint {
  x: number;
  z: number;
}

export interface Camouflage {
  color: string;
  surface: string;
}

type Quaternion = readonly [number, number, number, number];

interface ManifestCollider {
  id: string;
  source: string;
  type: "box" | "cylinder" | "convex" | "mesh";
  translation: readonly [number, number, number];
  rotation: Quaternion;
  halfExtents?: readonly [number, number, number];
  radius?: number;
  halfHeight?: number;
  points?: readonly (readonly [number, number, number])[];
}

interface CompoundManifest {
  visualCenter?: readonly [number, number, number];
  colliders: readonly ManifestCollider[];
}

interface Obstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  source: string;
}

interface GridCell {
  x: number;
  z: number;
}

const CELL_SIZE = 0.75;
const PLAYER_CLEARANCE = 0.42;
const PLAYER_HEIGHT = 2.3;
const BUNKER_LAYOUT_SCALE = 2 / 0.9;

/** The same five openings authored in shared/src/game/maps/bunker.ts. */
export const BUNKER_DOORS: readonly { min: NavPoint; max: NavPoint; center: NavPoint }[] = [
  door(4.7, -8.6, 6.1, -6.1),
  door(-6.3, -8.6, -4.9, -6.1),
  door(4.7, 2.2, 6.1, 4.7),
  door(-6.3, 2.2, -4.9, 4.7),
  door(-1.4, 14.8, 1.1, 16.2)
];

function door(minX: number, minZ: number, maxX: number, maxZ: number) {
  const min = { x: minX * BUNKER_LAYOUT_SCALE, z: minZ * BUNKER_LAYOUT_SCALE };
  const max = { x: maxX * BUNKER_LAYOUT_SCALE, z: maxZ * BUNKER_LAYOUT_SCALE };
  return { min, max, center: { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2 } };
}

export class NavigationMap {
  readonly cellSize = CELL_SIZE;
  readonly size = Math.ceil(WORLD_SIZE / CELL_SIZE);
  private readonly half = WORLD_SIZE / 2;
  private readonly blocked = new Uint8Array(this.size * this.size);
  private readonly obstacles: Obstacle[];

  constructor(manifest: CompoundManifest = loadBunkerManifest()) {
    this.obstacles = buildObstacles(manifest);
    for (const obstacle of this.obstacles) this.markObstacle(obstacle);
    // Some generated wall panels span their visible doorway. The authoritative
    // server removes those sections too, so the bot graph must preserve them.
    for (const opening of BUNKER_DOORS) this.clearRect(
      { x: opening.min.x - PLAYER_CLEARANCE, z: opening.min.z - PLAYER_CLEARANCE },
      { x: opening.max.x + PLAYER_CLEARANCE, z: opening.max.z + PLAYER_CLEARANCE }
    );
  }

  findPath(from: NavPoint, to: NavPoint): NavPoint[] {
    const start = this.nearestOpen(this.toCell(from));
    const goal = this.nearestOpen(this.toCell(to));
    if (!start || !goal) return [];
    const startIndex = this.index(start.x, start.z);
    const goalIndex = this.index(goal.x, goal.z);
    const cameFrom = new Int32Array(this.blocked.length).fill(-1);
    const cost = new Float64Array(this.blocked.length).fill(Infinity);
    const open: Array<{ index: number; score: number }> = [{ index: startIndex, score: 0 }];
    cost[startIndex] = 0;

    while (open.length) {
      let best = 0;
      for (let index = 1; index < open.length; index += 1) {
        if (open[index]!.score < open[best]!.score) best = index;
      }
      const current = open.splice(best, 1)[0]!.index;
      if (current === goalIndex) return this.reconstruct(cameFrom, current, from, to);
      const cell = this.fromIndex(current);
      for (const [dx, dz, stepCost] of NEIGHBORS) {
        const nextX = cell.x + dx;
        const nextZ = cell.z + dz;
        if (!this.isOpen(nextX, nextZ)) continue;
        if (dx !== 0 && dz !== 0 && (!this.isOpen(cell.x + dx, cell.z) || !this.isOpen(cell.x, cell.z + dz))) continue;
        const next = this.index(nextX, nextZ);
        const nextCost = cost[current]! + stepCost;
        if (nextCost >= cost[next]!) continue;
        cameFrom[next] = current;
        cost[next] = nextCost;
        const heuristic = Math.hypot(goal.x - nextX, goal.z - nextZ);
        const existing = open.find((entry) => entry.index === next);
        if (existing) existing.score = nextCost + heuristic;
        else open.push({ index: next, score: nextCost + heuristic });
      }
    }
    return [];
  }

  lineClear(from: NavPoint, to: NavPoint): boolean {
    const start = this.toCell(from);
    const end = this.toCell(to);
    const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.z - start.z));
    if (steps === 0) return this.isOpen(start.x, start.z);
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const x = Math.round(start.x + (end.x - start.x) * t);
      const z = Math.round(start.z + (end.z - start.z) * t);
      if (!this.isOpen(x, z)) return false;
    }
    return true;
  }

  findHidingSpot(origin: NavPoint, threats: readonly NavPoint[], seed: number): NavPoint {
    const start = this.nearestOpen(this.toCell(origin));
    if (!start) return origin;
    const reachable = this.reachableCells(start, 4_000);
    let best = start;
    let bestScore = -Infinity;
    for (const cell of reachable) {
      if ((cell.x + cell.z) % 2 !== 0) continue;
      const point = this.toWorld(cell);
      const cover = this.nearbyBlocked(cell);
      if (cover === 0) continue;
      const threatDistance = threats.length
        ? Math.min(...threats.map((threat) => distance(point, threat)))
        : distance(point, origin);
      const doorDistance = Math.min(...BUNKER_DOORS.map((opening) => distance(point, opening.center)));
      const travel = distance(point, origin);
      const jitter = pseudoRandom(cell.x * 92821 + cell.z * 68917 + seed * 1013) * 3;
      const score = threatDistance * 1.8 + cover * 6 + Math.min(doorDistance, 12) + Math.min(travel, 18) * 0.35 + jitter;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    return this.toWorld(best);
  }

  findRoamPoint(origin: NavPoint, seed: number): NavPoint {
    const start = this.nearestOpen(this.toCell(origin));
    if (!start) return origin;
    const cells = this.reachableCells(start, 1_500).filter((cell) => distance(this.toWorld(cell), origin) > 8);
    if (!cells.length) return origin;
    return this.toWorld(cells[Math.floor(pseudoRandom(seed) * cells.length)]!);
  }

  camouflageAt(point: NavPoint): Camouflage {
    let nearest: Obstacle | undefined;
    let nearestDistance = Infinity;
    for (const obstacle of this.obstacles) {
      const dx = Math.max(obstacle.minX - point.x, 0, point.x - obstacle.maxX);
      const dz = Math.max(obstacle.minZ - point.z, 0, point.z - obstacle.maxZ);
      const candidateDistance = Math.hypot(dx, dz);
      if (candidateDistance < nearestDistance) {
        nearestDistance = candidateDistance;
        nearest = obstacle;
      }
    }
    if (!nearest || nearestDistance > 3.5) return { color: WORLD_FLOOR_COLOR, surface: "concrete floor" };
    return camouflageForSource(nearest.source);
  }

  private reconstruct(cameFrom: Int32Array, current: number, from: NavPoint, to: NavPoint): NavPoint[] {
    const cells: GridCell[] = [];
    while (current >= 0) {
      cells.push(this.fromIndex(current));
      current = cameFrom[current]!;
    }
    cells.reverse();
    const points = cells.map((cell) => this.toWorld(cell));
    if (points.length) points[0] = from;
    if (points.length && this.lineClear(points.at(-1)!, to)) points[points.length - 1] = to;
    return simplifyPath(points, (first, second) => this.lineClear(first, second));
  }

  private reachableCells(start: GridCell, limit: number): GridCell[] {
    const result: GridCell[] = [];
    const queue = [start];
    const visited = new Uint8Array(this.blocked.length);
    visited[this.index(start.x, start.z)] = 1;
    for (let cursor = 0; cursor < queue.length && result.length < limit; cursor += 1) {
      const cell = queue[cursor]!;
      result.push(cell);
      for (const [dx, dz] of CARDINAL_NEIGHBORS) {
        const x = cell.x + dx;
        const z = cell.z + dz;
        if (!this.isOpen(x, z)) continue;
        const index = this.index(x, z);
        if (visited[index]) continue;
        visited[index] = 1;
        queue.push({ x, z });
      }
    }
    return result;
  }

  private nearbyBlocked(cell: GridCell): number {
    let count = 0;
    for (let dz = -2; dz <= 2; dz += 1) for (let dx = -2; dx <= 2; dx += 1) {
      if ((dx !== 0 || dz !== 0) && !this.isOpen(cell.x + dx, cell.z + dz)) count += 1;
    }
    return count;
  }

  private markObstacle(obstacle: Obstacle): void {
    const min = this.toCell({ x: obstacle.minX - PLAYER_CLEARANCE, z: obstacle.minZ - PLAYER_CLEARANCE });
    const max = this.toCell({ x: obstacle.maxX + PLAYER_CLEARANCE, z: obstacle.maxZ + PLAYER_CLEARANCE });
    for (let z = min.z; z <= max.z; z += 1) for (let x = min.x; x <= max.x; x += 1) {
      if (this.inBounds(x, z)) this.blocked[this.index(x, z)] = 1;
    }
  }

  private clearRect(minPoint: NavPoint, maxPoint: NavPoint): void {
    const min = this.toCell(minPoint);
    const max = this.toCell(maxPoint);
    for (let z = min.z; z <= max.z; z += 1) for (let x = min.x; x <= max.x; x += 1) {
      if (this.inBounds(x, z)) this.blocked[this.index(x, z)] = 0;
    }
  }

  private nearestOpen(cell: GridCell): GridCell | undefined {
    if (this.isOpen(cell.x, cell.z)) return cell;
    for (let radius = 1; radius <= 10; radius += 1) {
      for (let z = cell.z - radius; z <= cell.z + radius; z += 1) for (let x = cell.x - radius; x <= cell.x + radius; x += 1) {
        if ((Math.abs(x - cell.x) === radius || Math.abs(z - cell.z) === radius) && this.isOpen(x, z)) return { x, z };
      }
    }
    return undefined;
  }

  private toCell(point: NavPoint): GridCell {
    return {
      x: Math.max(0, Math.min(this.size - 1, Math.floor((point.x + this.half) / CELL_SIZE))),
      z: Math.max(0, Math.min(this.size - 1, Math.floor((point.z + this.half) / CELL_SIZE)))
    };
  }

  private toWorld(cell: GridCell): NavPoint {
    return { x: -this.half + (cell.x + 0.5) * CELL_SIZE, z: -this.half + (cell.z + 0.5) * CELL_SIZE };
  }

  private fromIndex(index: number): GridCell {
    return { x: index % this.size, z: Math.floor(index / this.size) };
  }

  private index(x: number, z: number): number {
    return z * this.size + x;
  }

  private isOpen(x: number, z: number): boolean {
    return this.inBounds(x, z) && this.blocked[this.index(x, z)] === 0;
  }

  private inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.size && z < this.size;
  }
}

const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
] as const;
const CARDINAL_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

function loadBunkerManifest(): CompoundManifest {
  const url = new URL("../../client/public/models/maps/bunker.compound-colliders.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as CompoundManifest;
}

function buildObstacles(manifest: CompoundManifest): Obstacle[] {
  const model = WORLD_MODELS.find((candidate) => candidate.id === "bunker");
  if (!model) return [];
  const center = manifest.visualCenter ?? [0, 0, 0];
  const scale = model.scale;
  const obstacles: Obstacle[] = [];
  for (const collider of manifest.colliders) {
    // The authoritative Rapier map splits this generated panel into a side and
    // lintel so the lower center doorway remains open.
    if (collider.source === "Wall.020__part_0055") continue;
    const localPoints = colliderPoints(collider);
    if (!localPoints.length) continue;
    const points = localPoints.map((point) => {
      const rotated = rotateVector([point[0] * scale[0], point[1] * scale[1], point[2] * scale[2]], collider.rotation);
      return [
        model.position[0] + (collider.translation[0] - center[0]) * scale[0] + rotated[0],
        model.position[1] + (collider.translation[1] - center[1]) * scale[1] + rotated[1],
        model.position[2] + (collider.translation[2] - center[2]) * scale[2] + rotated[2]
      ] as const;
    });
    const minY = Math.min(...points.map((point) => point[1]));
    const maxY = Math.max(...points.map((point) => point[1]));
    if (maxY < 0.2 || minY > PLAYER_HEIGHT) continue;
    obstacles.push({
      minX: Math.min(...points.map((point) => point[0])),
      maxX: Math.max(...points.map((point) => point[0])),
      minZ: Math.min(...points.map((point) => point[2])),
      maxZ: Math.max(...points.map((point) => point[2])),
      source: collider.source
    });
  }
  return obstacles;
}

function colliderPoints(collider: ManifestCollider): readonly (readonly [number, number, number])[] {
  if ((collider.type === "convex" || collider.type === "mesh") && collider.points) return collider.points;
  if (collider.type === "box" && collider.halfExtents) {
    const [x, y, z] = collider.halfExtents;
    return [
      [-x, -y, -z], [x, -y, -z], [-x, y, -z], [x, y, -z],
      [-x, -y, z], [x, -y, z], [-x, y, z], [x, y, z]
    ];
  }
  if (collider.type === "cylinder" && collider.radius !== undefined && collider.halfHeight !== undefined) {
    const result: [number, number, number][] = [];
    for (const y of [-collider.halfHeight, collider.halfHeight]) for (let index = 0; index < 12; index += 1) {
      const angle = index / 12 * Math.PI * 2;
      result.push([Math.cos(angle) * collider.radius, y, Math.sin(angle) * collider.radius]);
    }
    return result;
  }
  return [];
}

function rotateVector([x, y, z]: readonly [number, number, number], [qx, qy, qz, qw]: Quaternion): [number, number, number] {
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx
  ];
}

function camouflageForSource(source: string): Camouflage {
  const name = source.toLowerCase();
  if (name.includes("bed") || name.includes("plant") || name.includes("green")) return { color: "#596447", surface: source };
  if (name.includes("wall") || name.includes("concrete")) return { color: "#b0b0b0", surface: source };
  if (name.includes("floor")) return { color: "#d3d3d3", surface: source };
  if (name.includes("cabinet") || name.includes("bookshelf") || name.includes("table") || name.includes("wood")) return { color: "#664b3c", surface: source };
  if (name.includes("sofa") || name.includes("chair")) return { color: "#796b5e", surface: source };
  if (name.includes("metal") || name.includes("locker") || name.includes("shelf")) return { color: "#454147", surface: source };
  return { color: WORLD_FLOOR_COLOR, surface: source };
}

function simplifyPath(points: NavPoint[], lineClear: (first: NavPoint, second: NavPoint) => boolean): NavPoint[] {
  if (points.length < 3) return points;
  const result = [points[0]!];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = points.length - 1;
    while (next > anchor + 1 && !lineClear(points[anchor]!, points[next]!)) next -= 1;
    result.push(points[next]!);
    anchor = next;
  }
  return result;
}

function distance(first: NavPoint, second: NavPoint): number {
  return Math.hypot(first.x - second.x, first.z - second.z);
}

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

export function asNavPoint(point: Vec3): NavPoint {
  return { x: point.x, z: point.z };
}
