import {
  GAME,
  WORLD_BOXES,
  WORLD_HULLS,
  WORLD_SIZE,
  WORLD_WALL_THICKNESS,
  clamp,
  worldHullHeightAt,
  worldHullFootprint,
  type SurfaceClingState,
  type Vec3,
  type WorldHull
} from "@mechfall/shared";
import {
  hasCompoundWorldCollision,
  isCompoundCollisionSurface,
  moveBodyWithRapier,
  moveClingingBodyWithRapier
} from "./rapierCollision.js";

export interface PhysicsBody {
  position: Vec3;
  velocity: Vec3;
}

export type ClingMoveResult = "attached" | "released" | "mantled";

interface HullSurface {
  hull: WorldHull;
  points: readonly (readonly [number, number])[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
  solidTop: boolean;
}

interface WalkableHullSupport {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
}

interface HullFootprintSupports {
  highest?: WalkableHullSupport;
  walkable?: WalkableHullSupport;
}

const SOLID_TOP_HEIGHT_EPSILON = 0.15;
const SOLID_TOP_VERTEX_RATIO = 0.05;
const SOLID_TOP_TRIANGLE_RATIO = 0.02;
const SOLID_TOP_MIN_NORMAL_Y = 0.9;

const HULL_SURFACES: readonly HullSurface[] = WORLD_HULLS
  .filter((hull) => hull.solid && hull.vertices.length >= 4)
  .map(makeHullSurface);

function makeHullSurface(hull: WorldHull): HullSurface {
  const footprint = worldHullFootprint(hull);
  return {
    hull,
    ...footprint,
    minX: Math.min(...footprint.points.map((point) => point[0])),
    maxX: Math.max(...footprint.points.map((point) => point[0])),
    minZ: Math.min(...footprint.points.map((point) => point[1])),
    maxZ: Math.max(...footprint.points.map((point) => point[1])),
    solidTop: worldHullHasSolidTop(hull, footprint.maxY)
  };
}

/** Detailed box-like models receive a continuous roof despite tiny mesh gaps. */
export function worldHullHasSolidTop(hull: WorldHull, maxY?: number): boolean {
  if (!hull.triangles?.length || hull.vertices.length === 0) return false;
  const top = maxY ?? Math.max(...hull.vertices.map((vertex) => vertex[1]));
  const nearTopVertices = hull.vertices.filter((vertex) => vertex[1] >= top - SOLID_TOP_HEIGHT_EPSILON).length;
  if (nearTopVertices / hull.vertices.length < SOLID_TOP_VERTEX_RATIO) return false;

  let horizontalTopTriangles = 0;
  for (const triangle of hull.triangles) {
    const a = hull.vertices[triangle[0]];
    const b = hull.vertices[triangle[1]];
    const c = hull.vertices[triangle[2]];
    if (!a || !b || !c || (a[1] + b[1] + c[1]) / 3 < top - SOLID_TOP_HEIGHT_EPSILON) continue;
    const edgeABX = b[0] - a[0];
    const edgeABY = b[1] - a[1];
    const edgeABZ = b[2] - a[2];
    const edgeACX = c[0] - a[0];
    const edgeACY = c[1] - a[1];
    const edgeACZ = c[2] - a[2];
    const normalX = edgeABY * edgeACZ - edgeABZ * edgeACY;
    const normalY = edgeABZ * edgeACX - edgeABX * edgeACZ;
    const normalZ = edgeABX * edgeACY - edgeABY * edgeACX;
    const normalLength = Math.hypot(normalX, normalY, normalZ);
    if (normalLength > Number.EPSILON
        && Math.abs(normalY) / normalLength >= SOLID_TOP_MIN_NORMAL_Y) horizontalTopTriangles += 1;
  }
  return horizontalTopTriangles / hull.triangles.length >= SOLID_TOP_TRIANGLE_RATIO;
}

export function moveBody(
  body: PhysicsBody,
  wishX: number,
  wishZ: number,
  speed: number,
  jump: boolean,
  yaw: number,
  dt: number
): SurfaceClingState | undefined {
  if (hasCompoundWorldCollision) {
    return moveBodyWithRapier(body, wishX, wishZ, speed, jump, yaw, dt);
  }
  const length = Math.hypot(wishX, wishZ);
  const normalizedX = length > 1 ? wishX / length : wishX;
  const normalizedZ = length > 1 ? wishZ / length : wishZ;
  const response = 1 - Math.exp(-18 * dt);

  body.velocity.x += (normalizedX * speed - body.velocity.x) * response;
  body.velocity.z += (normalizedZ * speed - body.velocity.z) * response;

  const grounded = isGrounded(body, yaw);
  if (jump && grounded) body.velocity.y = GAME.jumpSpeed;
  body.velocity.y -= GAME.gravity * dt;

  // A yaw change can widen the footprint while the center is stationary.
  // Resolve that overlap on the shallowest axis without reporting a movement
  // collision, so rotation alone cannot attach a player to a wall.
  depenetrateBody(body, yaw);
  const followWalkableSurfaces = grounded && !jump;
  const horizontalDistance = Math.hypot(body.velocity.x * dt, body.velocity.z * dt);
  const probeScale = horizontalDistance > Number.EPSILON
    ? (horizontalDistance + WALKABLE_SURFACE_PROBE) / horizontalDistance
    : 1;
  const walkableProbeX = body.position.x + body.velocity.x * dt * probeScale;
  const walkableProbeZ = body.position.z + body.velocity.z * dt * probeScale;
  const xCollision = moveAxis(
    body,
    "x",
    body.velocity.x * dt,
    yaw,
    followWalkableSurfaces,
    walkableProbeX,
    walkableProbeZ
  );
  const zCollision = moveAxis(
    body,
    "z",
    body.velocity.z * dt,
    yaw,
    followWalkableSurfaces,
    body.position.x,
    body.position.z + body.velocity.z * dt + Math.sign(body.velocity.z) * WALKABLE_SURFACE_PROBE
  );
  if (followWalkableSurfaces) followWalkableHullSurfaces(body, yaw);
  // Sequential X/Z movement can cross two faces at a sharp convex corner in
  // one tick. Resolve both planes immediately instead of leaving the body
  // slightly inside until the next tick, where it could be pushed through.
  depenetrateBody(body, yaw);
  moveVertically(body, yaw, dt);

  const limitX = worldLimit(yaw, 1, 0, body.position.y);
  const limitZ = worldLimit(yaw, 0, 1, body.position.y);
  const clampedX = clamp(body.position.x, -limitX, limitX);
  const clampedZ = clamp(body.position.z, -limitZ, limitZ);
  if (clampedX !== body.position.x) body.velocity.x = 0;
  if (clampedZ !== body.position.z) body.velocity.z = 0;
  body.position.x = clampedX;
  body.position.z = clampedZ;
  return xCollision ?? zCollision;
}

/**
 * Space/Shift drive vertical movement while attached, and A/D always move
 * sideways. Forward or backward input releases only when it points away from
 * the contacted surface.
 */
export function wantsToDetachFromSurface(
  cling: SurfaceClingState,
  yaw: number,
  forward: number
): boolean {
  const signedForward = clamp(forward, -1, 1);
  if (Math.abs(signedForward) < 0.2) return false;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const direction = Math.sign(signedForward);
  const wishX = -sin * direction;
  const wishZ = -cos * direction;
  const outward = wishX * cling.normalX + wishZ * cling.normalZ;
  return outward > CLING_DETACH_THRESHOLD;
}

export function moveClingingBody(
  body: PhysicsBody,
  cling: SurfaceClingState,
  yaw: number,
  sideways: number,
  vertical: number,
  dt: number
): ClingMoveResult {
  if (hasCompoundWorldCollision && isCompoundCollisionSurface(cling.surfaceId)) {
    return moveClingingBodyWithRapier(body, cling, sideways, vertical, dt);
  }
  const box = WORLD_BOXES.find((candidate) => candidate.solid && candidate.id === cling.surfaceId);
  if (!box) {
    const surface = HULL_SURFACES.find((candidate) => candidate.hull.id === cling.surfaceId);
    return surface ? moveClingingOnHull(body, cling, yaw, sideways, vertical, dt, surface) : "released";
  }
  if (Math.abs(cling.normalX) + Math.abs(cling.normalZ) !== 1) return "released";
  const previousX = body.position.x;
  const previousY = body.position.y;
  const previousZ = body.position.z;
  const minX = box.position[0] - box.size[0] / 2;
  const maxX = box.position[0] + box.size[0] / 2;
  const minY = box.position[1] - box.size[1] / 2;
  const maxY = box.position[1] + box.size[1] / 2;
  const minZ = box.position[2] - box.size[2] / 2;
  const maxZ = box.position[2] + box.size[2] / 2;
  const contactDistance = playerContactDistance(yaw, cling.normalX, cling.normalZ);
  const worldLimitX = worldLimit(yaw, 1, 0, body.position.y);
  const worldLimitZ = worldLimit(yaw, 0, 1, body.position.y);
  const rawContactX = cling.normalX < 0 ? minX - contactDistance : cling.normalX > 0 ? maxX + contactDistance : body.position.x;
  const rawContactZ = cling.normalZ < 0 ? minZ - contactDistance : cling.normalZ > 0 ? maxZ + contactDistance : body.position.z;
  const contactX = cling.normalX !== 0 ? clamp(rawContactX, -worldLimitX, worldLimitX) : body.position.x;
  const contactZ = cling.normalZ !== 0 ? clamp(rawContactZ, -worldLimitZ, worldLimitZ) : body.position.z;
  if (Math.hypot(body.position.x - contactX, body.position.z - contactZ) > CLING_LOST_DISTANCE) return "released";

  const tangentX = cling.normalZ;
  const tangentZ = -cling.normalX;
  const sideSpeed = clamp(sideways, -1, 1) * GAME.climbSpeed;
  const climbSpeed = clamp(vertical, -1, 1) * GAME.climbSpeed;
  const lowest = Math.max(0, minY - CLING_BODY_HEIGHT + CLING_MIN_OVERLAP);
  const highest = Math.max(lowest, maxY - CLING_MIN_OVERLAP);
  if (body.position.y < lowest - CLING_EDGE_RELEASE_EPSILON
      || body.position.y > highest + CLING_EDGE_RELEASE_EPSILON) return "released";
  const currentTangent = cling.normalX !== 0 ? body.position.z : body.position.x;
  const tangentWorldLimit = cling.normalX !== 0 ? worldLimitZ : worldLimitX;
  const tangentMin = Math.max(cling.normalX !== 0 ? minZ : minX, -tangentWorldLimit);
  const tangentMax = Math.min(cling.normalX !== 0 ? maxZ : maxX, tangentWorldLimit);
  if (currentTangent < tangentMin - CLING_EDGE_RELEASE_EPSILON
      || currentTangent > tangentMax + CLING_EDGE_RELEASE_EPSILON) return "released";
  const tangentDirection = cling.normalX !== 0 ? tangentZ : tangentX;
  const tangentDelta = tangentDirection * sideSpeed * dt;
  const nextTangent = currentTangent + tangentDelta;
  const nextY = body.position.y + climbSpeed * dt;

  body.position.x = contactX + tangentX * sideSpeed * dt;
  body.position.z = contactZ + tangentZ * sideSpeed * dt;
  if (cling.normalX !== 0) body.position.z = clamp(nextTangent, tangentMin, tangentMax);
  else body.position.x = clamp(nextTangent, tangentMin, tangentMax);
  body.position.y = clamp(nextY, lowest, highest);
  if (dt > 0) {
    const deltaX = body.position.x - previousX;
    const deltaZ = body.position.z - previousZ;
    const actualTangentDelta = deltaX * tangentX + deltaZ * tangentZ;
    body.velocity.x = tangentX * actualTangentDelta / dt;
    body.velocity.y = (body.position.y - previousY) / dt;
    body.velocity.z = tangentZ * actualTangentDelta / dt;
  } else {
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
  }

  const leavingSide = (tangentDelta < 0 && nextTangent < tangentMin - CLING_EDGE_RELEASE_EPSILON)
    || (tangentDelta > 0 && nextTangent > tangentMax + CLING_EDGE_RELEASE_EPSILON);
  const leavingBottom = climbSpeed < 0 && nextY < lowest - CLING_EDGE_RELEASE_EPSILON;
  const leavingTop = climbSpeed > 0 && nextY > highest + CLING_EDGE_RELEASE_EPSILON;
  if (leavingTop && !leavingSide) {
    const mantleDistance = contactDistance * 2 + MANTLE_TOP_INSET;
    const topLimitX = worldLimit(yaw, 1, 0, maxY);
    const topLimitZ = worldLimit(yaw, 0, 1, maxY);
    const targetX = clamp(contactX - cling.normalX * mantleDistance, -topLimitX, topLimitX);
    const targetZ = clamp(contactZ - cling.normalZ * mantleDistance, -topLimitZ, topLimitZ);
    if (canOccupyMantleTarget(box.id, targetX, targetZ, maxY, yaw)) {
      body.position.x = targetX;
      body.position.z = targetZ;
      body.position.y = maxY;
      body.velocity.x = 0;
      body.velocity.y = 0;
      body.velocity.z = 0;
      return "mantled";
    }
    body.velocity.y = 0;
    return "attached";
  }
  if (leavingSide || leavingBottom) return "released";
  return "attached";
}

function moveClingingOnHull(
  body: PhysicsBody,
  cling: SurfaceClingState,
  yaw: number,
  sideways: number,
  vertical: number,
  dt: number,
  surface: HullSurface
): ClingMoveResult {
  const matched = selectClosestHullClingEdge(surface.points, body.position, yaw, cling.normalX, cling.normalZ);
  if (!matched) return "released";

  const previousX = body.position.x;
  const previousY = body.position.y;
  const previousZ = body.position.z;
  const tangentX = matched.normalZ;
  const tangentZ = -matched.normalX;
  const contactDistance = playerContactDistance(yaw, matched.normalX, matched.normalZ);
  const normalCoordinate = matched.start[0] * matched.normalX + matched.start[1] * matched.normalZ + contactDistance;
  const currentTangent = body.position.x * tangentX + body.position.z * tangentZ;
  const contactX = matched.normalX * normalCoordinate + tangentX * currentTangent;
  const contactZ = matched.normalZ * normalCoordinate + tangentZ * currentTangent;
  if (Math.hypot(body.position.x - contactX, body.position.z - contactZ) > CLING_LOST_DISTANCE) return "released";

  const tangentA = matched.start[0] * tangentX + matched.start[1] * tangentZ;
  const tangentB = matched.end[0] * tangentX + matched.end[1] * tangentZ;
  const tangentMin = Math.min(tangentA, tangentB);
  const tangentMax = Math.max(tangentA, tangentB);
  const lowest = Math.max(0, surface.minY - CLING_BODY_HEIGHT + CLING_MIN_OVERLAP);
  const highest = Math.max(lowest, surface.maxY - CLING_MIN_OVERLAP);
  if (body.position.y < lowest - CLING_EDGE_RELEASE_EPSILON
      || body.position.y > highest + CLING_EDGE_RELEASE_EPSILON
      || currentTangent < tangentMin - CLING_EDGE_RELEASE_EPSILON
      || currentTangent > tangentMax + CLING_EDGE_RELEASE_EPSILON) return "released";

  const sideSpeed = clamp(sideways, -1, 1) * GAME.climbSpeed;
  const climbSpeed = clamp(vertical, -1, 1) * GAME.climbSpeed;
  const nextTangent = currentTangent + sideSpeed * dt;
  const nextY = body.position.y + climbSpeed * dt;
  const clampedTangent = clamp(nextTangent, tangentMin, tangentMax);
  body.position.x = clamp(matched.normalX * normalCoordinate + tangentX * clampedTangent, -worldLimit(yaw, 1, 0, body.position.y), worldLimit(yaw, 1, 0, body.position.y));
  body.position.z = clamp(matched.normalZ * normalCoordinate + tangentZ * clampedTangent, -worldLimit(yaw, 0, 1, body.position.y), worldLimit(yaw, 0, 1, body.position.y));
  body.position.y = clamp(nextY, lowest, highest);
  if (dt > 0) {
    body.velocity.x = (body.position.x - previousX) / dt;
    body.velocity.y = (body.position.y - previousY) / dt;
    body.velocity.z = (body.position.z - previousZ) / dt;
  } else {
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
  }

  const leavingSide = (sideSpeed < 0 && nextTangent < tangentMin - CLING_EDGE_RELEASE_EPSILON)
    || (sideSpeed > 0 && nextTangent > tangentMax + CLING_EDGE_RELEASE_EPSILON);
  const leavingBottom = climbSpeed < 0 && nextY < lowest - CLING_EDGE_RELEASE_EPSILON;
  const leavingTop = climbSpeed > 0 && nextY > highest + CLING_EDGE_RELEASE_EPSILON;
  if (leavingTop && !leavingSide) {
    const mantleDistance = contactDistance * 2 + MANTLE_TOP_INSET;
    const targetX = clamp(body.position.x - matched.normalX * mantleDistance, -worldLimit(yaw, 1, 0, surface.maxY), worldLimit(yaw, 1, 0, surface.maxY));
    const targetZ = clamp(body.position.z - matched.normalZ * mantleDistance, -worldLimit(yaw, 0, 1, surface.maxY), worldLimit(yaw, 0, 1, surface.maxY));
    if (canOccupyMantleTarget(surface.hull.id, targetX, targetZ, surface.maxY, yaw)) {
      body.position.x = targetX;
      body.position.z = targetZ;
      body.position.y = surface.maxY;
      body.velocity.x = 0;
      body.velocity.y = 0;
      body.velocity.z = 0;
      return "mantled";
    }
    body.velocity.y = 0;
    return "attached";
  }
  if (leavingSide || leavingBottom) return "released";
  return "attached";
}

/** Selects the nearby segment when detailed meshes contain parallel outline edges. */
export function selectClosestHullClingEdge(
  points: readonly (readonly [number, number])[],
  position: Pick<Vec3, "x" | "z">,
  yaw: number,
  normalX: number,
  normalZ: number
): { start: readonly [number, number]; end: readonly [number, number]; normalX: number; normalZ: number } | undefined {
  let matched: { start: readonly [number, number]; end: readonly [number, number]; normalX: number; normalZ: number } | undefined;
  let matchedDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const edge = normalizedHullEdge(start, end);
    if (!edge || edge.normalX * normalX + edge.normalZ * normalZ < 0.999) continue;
    const contactDistance = playerContactDistance(yaw, edge.normalX, edge.normalZ);
    const normalCoordinate = start[0] * edge.normalX + start[1] * edge.normalZ + contactDistance;
    const bodyNormalCoordinate = position.x * edge.normalX + position.z * edge.normalZ;
    const tangentX = edge.normalZ;
    const tangentZ = -edge.normalX;
    const bodyTangent = position.x * tangentX + position.z * tangentZ;
    const tangentA = start[0] * tangentX + start[1] * tangentZ;
    const tangentB = end[0] * tangentX + end[1] * tangentZ;
    const tangentMin = Math.min(tangentA, tangentB);
    const tangentMax = Math.max(tangentA, tangentB);
    const tangentOverflow = bodyTangent < tangentMin
      ? tangentMin - bodyTangent
      : bodyTangent > tangentMax
        ? bodyTangent - tangentMax
        : 0;
    const distance = Math.hypot(bodyNormalCoordinate - normalCoordinate, tangentOverflow);
    if (distance >= matchedDistance) continue;
    matchedDistance = distance;
    matched = { start, end, normalX: edge.normalX, normalZ: edge.normalZ };
  }
  return matched;
}

function moveVertically(body: PhysicsBody, yaw: number, dt: number): void {
  const previousY = body.position.y;
  const nextY = previousY + body.velocity.y * dt;
  if (body.velocity.y <= 0) {
    let landingY = previousY >= -PLATFORM_EPSILON && nextY <= PLATFORM_EPSILON ? 0 : -Infinity;
    for (const box of WORLD_BOXES) {
      if (!box.solid || !footprintOverlapsTop(body, yaw, box)) continue;
      const top = box.position[1] + box.size[1] / 2;
      if (previousY + PLATFORM_EPSILON < top || nextY > top + PLATFORM_EPSILON) continue;
      landingY = Math.max(landingY, top);
    }
    for (const surface of HULL_SURFACES) {
      if (!footprintOverlapsHullAt(body.position.x, body.position.z, yaw, surface, PLATFORM_EPSILON)) continue;
      const top = hullSupportTop(surface, body.position.x, body.position.z, yaw);
      if (top === undefined || previousY + PLATFORM_EPSILON < top || nextY > top + PLATFORM_EPSILON) continue;
      landingY = Math.max(landingY, top);
    }
    if (landingY > -Infinity) {
      body.position.y = landingY;
      body.velocity.y = 0;
      return;
    }
  }

  body.position.y = Math.max(0, nextY);
  if (body.position.y === 0 && body.velocity.y < 0) body.velocity.y = 0;
}

function isGrounded(body: PhysicsBody, yaw: number): boolean {
  if (Math.abs(body.position.y) <= PLATFORM_EPSILON) return true;
  for (const box of WORLD_BOXES) {
    if (!box.solid || !footprintOverlapsTop(body, yaw, box)) continue;
    const top = box.position[1] + box.size[1] / 2;
    if (Math.abs(body.position.y - top) <= PLATFORM_EPSILON) return true;
  }
  for (const surface of HULL_SURFACES) {
    // Exact edge contact still counts as grounded. Requiring even a tiny
    // overlap makes detailed diagonal meshes alternate grounded/airborne as
    // their sampled outline changes from one triangle to the next.
    if (!footprintOverlapsHullAt(body.position.x, body.position.z, yaw, surface, 0)) continue;
    const support = surface.hull.triangles?.length
      ? walkableHullSupport(surface, body.position.x, body.position.z, yaw)
      : undefined;
    const top = support?.height ?? hullSupportTop(surface, body.position.x, body.position.z, yaw);
    if (top === undefined) continue;
    if (support
      ? isWalkableGroundContact(body.position.y, top)
      : Math.abs(body.position.y - top) <= PLATFORM_EPSILON) return true;
  }
  return false;
}

function footprintOverlapsTop(body: PhysicsBody, yaw: number, box: (typeof WORLD_BOXES)[number]): boolean {
  return footprintOverlapsTopAt(body.position.x, body.position.z, yaw, box, PLATFORM_EPSILON);
}

function footprintOverlapsTopAt(
  x: number,
  z: number,
  yaw: number,
  box: (typeof WORLD_BOXES)[number],
  minimumOverlap: number
): boolean {
  const extentX = playerContactDistance(yaw, 1, 0);
  const extentZ = playerContactDistance(yaw, 0, 1);
  const minX = box.position[0] - box.size[0] / 2;
  const maxX = box.position[0] + box.size[0] / 2;
  const minZ = box.position[2] - box.size[2] / 2;
  const maxZ = box.position[2] + box.size[2] / 2;
  return x + extentX > minX + minimumOverlap
    && x - extentX < maxX - minimumOverlap
    && z + extentZ > minZ + minimumOverlap
    && z - extentZ < maxZ - minimumOverlap;
}

function footprintOverlapsHullAt(
  x: number,
  z: number,
  yaw: number,
  surface: HullSurface,
  minimumOverlap: number
): boolean {
  if (surface.points.length < 3) return false;
  const extentX = playerContactDistance(yaw, 1, 0);
  const extentZ = playerContactDistance(yaw, 0, 1);
  if (x + extentX <= surface.minX + minimumOverlap
      || x - extentX >= surface.maxX - minimumOverlap
      || z + extentZ <= surface.minZ + minimumOverlap
      || z - extentZ >= surface.maxZ - minimumOverlap) return false;
  for (let index = 0; index < surface.points.length; index += 1) {
    const start = surface.points[index]!;
    const end = surface.points[(index + 1) % surface.points.length]!;
    const edge = normalizedHullEdge(start, end);
    if (!edge) continue;
    const expansion = Math.max(0, playerContactDistance(yaw, edge.normalX, edge.normalZ) - minimumOverlap);
    if ((x - start[0]) * edge.normalX + (z - start[1]) * edge.normalZ > expansion) return false;
  }
  return true;
}

function hullSupportTop(surface: HullSurface, x: number, z: number, yaw: number): number | undefined {
  if (!surface.hull.triangles?.length || surface.solidTop) return surface.maxY;
  let highest = -Infinity;
  for (const sample of playerFootprintSamples(x, z, yaw)) {
    const height = worldHullHeightAt(surface.hull, sample[0], sample[1]);
    if (height !== undefined) highest = Math.max(highest, height);
  }
  return highest > -Infinity ? highest : undefined;
}

function playerFootprintSamples(x: number, z: number, yaw: number): readonly (readonly [number, number])[] {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const sideX = cos * GAME.playerHalfWidth;
  const sideZ = -sin * GAME.playerHalfWidth;
  const depthX = sin * GAME.playerHalfDepth;
  const depthZ = cos * GAME.playerHalfDepth;
  return [
    [x, z],
    [x - sideX * 0.82, z - sideZ * 0.82], [x + sideX * 0.82, z + sideZ * 0.82],
    [x - depthX * 0.82, z - depthZ * 0.82], [x + depthX * 0.82, z + depthZ * 0.82],
    [x - sideX * 0.58 - depthX * 0.58, z - sideZ * 0.58 - depthZ * 0.58],
    [x + sideX * 0.58 - depthX * 0.58, z + sideZ * 0.58 - depthZ * 0.58],
    [x - sideX * 0.58 + depthX * 0.58, z - sideZ * 0.58 + depthZ * 0.58],
    [x + sideX * 0.58 + depthX * 0.58, z + sideZ * 0.58 + depthZ * 0.58]
  ];
}

/** Returns the uppermost walkable triangle at a point. */
export function walkableWorldHullHeightAt(hull: WorldHull, x: number, z: number): number | undefined {
  return walkableWorldHullSurfaceAt(hull, x, z)?.height;
}

function walkableWorldHullSurfaceAt(hull: WorldHull, x: number, z: number): WalkableHullSupport | undefined {
  const support = worldHullSurfaceAt(hull, x, z);
  return support && support.normalY >= MIN_WALKABLE_NORMAL_Y ? support : undefined;
}

function worldHullSurfaceAt(hull: WorldHull, x: number, z: number): WalkableHullSupport | undefined {
  if (!hull.triangles?.length) return undefined;
  let highest: WalkableHullSupport | undefined;
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

    const edgeABX = b[0] - a[0];
    const edgeABY = b[1] - a[1];
    const edgeABZ = b[2] - a[2];
    const edgeACX = c[0] - a[0];
    const edgeACY = c[1] - a[1];
    const edgeACZ = c[2] - a[2];
    const normalX = edgeABY * edgeACZ - edgeABZ * edgeACY;
    const normalY = edgeABZ * edgeACX - edgeABX * edgeACZ;
    const normalZ = edgeABX * edgeACY - edgeABY * edgeACX;
    const normalLength = Math.hypot(normalX, normalY, normalZ);
    if (normalLength <= Number.EPSILON) continue;
    const height = first * a[1] + second * b[1] + third * c[1];
    const upwardSign = normalY < 0 ? -1 : 1;
    const surface = {
      height,
      normalX: normalX / normalLength * upwardSign,
      normalY: Math.abs(normalY) / normalLength,
      normalZ: normalZ / normalLength * upwardSign
    };
    if (!highest || height > highest.height + SURFACE_HEIGHT_EPSILON
        || (Math.abs(height - highest.height) <= SURFACE_HEIGHT_EPSILON && surface.normalY > highest.normalY)) {
      highest = surface;
    }
  }
  return highest;
}

function hullFootprintSupports(surface: HullSurface, x: number, z: number, yaw: number): HullFootprintSupports {
  if (!footprintOverlapsHullAt(x, z, yaw, surface, 0)) return {};
  if (surface.solidTop) {
    const roof = { height: surface.maxY, normalX: 0, normalY: 1, normalZ: 0 };
    return { highest: roof, walkable: roof };
  }
  let highest: WalkableHullSupport | undefined;
  let walkable: WalkableHullSupport | undefined;
  for (const sample of playerFootprintSamples(x, z, yaw)) {
    const support = worldHullSurfaceAt(surface.hull, sample[0], sample[1]);
    if (support && (!highest || support.height > highest.height)) highest = support;
    if (support?.normalY !== undefined && support.normalY >= MIN_WALKABLE_NORMAL_Y
        && (!walkable || support.height > walkable.height)) walkable = support;
  }
  return { highest, walkable };
}

function walkableHullSupport(surface: HullSurface, x: number, z: number, yaw: number): WalkableHullSupport | undefined {
  const supports = hullFootprintSupports(surface, x, z, yaw);
  if (!supports.walkable) return undefined;
  if (supports.highest && supports.highest.height > supports.walkable.height + SURFACE_HEIGHT_EPSILON) return undefined;
  return supports.walkable;
}

/** Full player-footprint support used by tests and collision previews. */
export function walkableWorldHullSupportHeightAt(
  hull: WorldHull,
  x: number,
  z: number,
  yaw: number
): number | undefined {
  const surface = makeHullSurface(hull);
  return walkableHullSupport(surface, x, z, yaw)?.height;
}

function followWalkableHullSurfaces(body: PhysicsBody, yaw: number, allowDescending = true): void {
  let targetHeight = -Infinity;
  for (const surface of HULL_SURFACES) {
    const support = walkableHullSupport(surface, body.position.x, body.position.z, yaw);
    if (!support) continue;
    if (!canFollowWalkableHeight(body.position.y, support.height, allowDescending)) continue;
    targetHeight = Math.max(targetHeight, support.height);
  }
  if (targetHeight === -Infinity) return;
  body.position.y = Math.max(0, targetHeight);
  body.velocity.y = 0;
}

/** Shared by movement and regression tests for detailed diagonal contact. */
export function canFollowWalkableHeight(feetY: number, supportY: number, allowDescending = true): boolean {
  const rise = supportY - feetY;
  if (rise > MAX_WALK_STEP_HEIGHT || rise < -MAX_WALK_GROUND_SNAP) return false;
  return allowDescending || rise >= -SURFACE_HEIGHT_EPSILON;
}

export function isWalkableGroundContact(feetY: number, supportY: number): boolean {
  return Math.abs(feetY - supportY) <= WALKABLE_GROUND_CONTACT_TOLERANCE;
}

function canReachWalkableHullAt(
  surface: HullSurface,
  x: number,
  z: number,
  feetY: number,
  yaw: number
): boolean {
  const support = walkableHullSupport(surface, x, z, yaw);
  if (!support) return false;
  const rise = support.height - feetY;
  return rise <= MAX_WALK_STEP_HEIGHT && rise >= -MAX_WALK_GROUND_SNAP;
}

function blockingHullSupportAt(
  surface: HullSurface,
  x: number,
  z: number,
  yaw: number
): WalkableHullSupport | undefined {
  const supports = hullFootprintSupports(surface, x, z, yaw);
  if (!supports.highest) return undefined;
  if (supports.walkable
      && supports.highest.height <= supports.walkable.height + SURFACE_HEIGHT_EPSILON) return undefined;
  return supports.highest;
}

function canOccupyMantleTarget(surfaceId: string, x: number, z: number, feetY: number, yaw: number): boolean {
  for (const box of WORLD_BOXES) {
    if (!box.solid || box.id === surfaceId) continue;
    const bottom = box.position[1] - box.size[1] / 2;
    const top = box.position[1] + box.size[1] / 2;
    const verticallyBlocked = feetY < top - PLATFORM_EPSILON
      && feetY + CLING_BODY_HEIGHT > bottom + PLATFORM_EPSILON;
    if (verticallyBlocked && footprintOverlapsTopAt(x, z, yaw, box, PLATFORM_EPSILON)) return false;
  }
  for (const surface of HULL_SURFACES) {
    if (surface.hull.id === surfaceId) continue;
    const verticallyBlocked = feetY < surface.maxY - PLATFORM_EPSILON
      && feetY + CLING_BODY_HEIGHT > surface.minY + PLATFORM_EPSILON;
    if (verticallyBlocked && footprintOverlapsHullAt(x, z, yaw, surface, PLATFORM_EPSILON)) return false;
  }
  return true;
}

function moveAxis(
  body: PhysicsBody,
  axis: "x" | "z",
  amount: number,
  yaw: number,
  allowWalkableFollow: boolean,
  walkableTargetX: number,
  walkableTargetZ: number
): SurfaceClingState | undefined {
  if (Math.abs(amount) <= Number.EPSILON) return undefined;
  const previous = body.position[axis];
  body.position[axis] += amount;
  const attempted = body.position[axis];
  const extentX = playerContactDistance(yaw, 1, 0);
  const extentZ = playerContactDistance(yaw, 0, 1);
  let collision: SurfaceClingState | undefined;

  for (const box of WORLD_BOXES) {
    if (!box.solid) continue;
    const top = box.position[1] + box.size[1] / 2;
    if (body.position.y > top - 0.1) continue;

    const minX = box.position[0] - box.size[0] / 2 - extentX;
    const maxX = box.position[0] + box.size[0] / 2 + extentX;
    const minZ = box.position[2] - box.size[2] / 2 - extentZ;
    const maxZ = box.position[2] + box.size[2] / 2 + extentZ;
    if (body.position.x <= minX || body.position.x >= maxX || body.position.z <= minZ || body.position.z >= maxZ) continue;

    if (axis === "x") {
      const hitMin = previous <= minX || (previous < maxX && Math.abs(body.position.x - minX) <= Math.abs(maxX - body.position.x));
      body.position.x = hitMin ? minX : maxX;
      body.velocity.x = 0;
      const crossedFace = (amount > 0 && previous <= minX && attempted > minX)
        || (amount < 0 && previous >= maxX && attempted < maxX);
      if (crossedFace) collision ??= { surfaceId: box.id, normalX: hitMin ? -1 : 1, normalZ: 0 };
    } else {
      const hitMin = previous <= minZ || (previous < maxZ && Math.abs(body.position.z - minZ) <= Math.abs(maxZ - body.position.z));
      body.position.z = hitMin ? minZ : maxZ;
      body.velocity.z = 0;
      const crossedFace = (amount > 0 && previous <= minZ && attempted > minZ)
        || (amount < 0 && previous >= maxZ && attempted < maxZ);
      if (crossedFace) collision ??= { surfaceId: box.id, normalX: 0, normalZ: hitMin ? -1 : 1 };
    }
  }

  // The first axis is only an intermediate point in diagonal movement. It may
  // raise onto a slope, but must not snap downward into a triangle gap before
  // the second axis reaches the real destination.
  if (allowWalkableFollow) followWalkableHullSurfaces(body, yaw, false);

  for (const surface of HULL_SURFACES) {
    if (body.position.y > surface.maxY - 0.1 || body.position.y + CLING_BODY_HEIGHT < surface.minY + 0.1) continue;
    const fromX = axis === "x" ? previous : body.position.x;
    const fromZ = axis === "z" ? previous : body.position.z;
    const previousWalkableSupport = walkableHullSupport(surface, fromX, fromZ, yaw);
    const blockingSupport = allowWalkableFollow
      ? blockingHullSupportAt(surface, body.position.x, body.position.z, yaw)
      : undefined;
    if (previousWalkableSupport
        && Math.abs(body.position.y - previousWalkableSupport.height) <= WALKABLE_SUPPORT_CONTACT_EPSILON
        && blockingSupport
        && body.position.y < blockingSupport.height - SURFACE_CLEARANCE) {
      const horizontalNormalLength = Math.hypot(blockingSupport.normalX, blockingSupport.normalZ);
      if (horizontalNormalLength > Number.EPSILON) {
        const normalX = blockingSupport.normalX / horizontalNormalLength;
        const normalZ = blockingSupport.normalZ / horizontalNormalLength;
        const inwardVelocity = body.velocity.x * normalX + body.velocity.z * normalZ;
        if (inwardVelocity < 0) {
          body.position[axis] = previous;
          body.velocity.x -= inwardVelocity * normalX;
          body.velocity.z -= inwardVelocity * normalZ;
          collision ??= { surfaceId: surface.hull.id, normalX, normalZ };
          continue;
        }
      }
    }
    const hit = sweepExpandedHull(fromX, fromZ, body.position.x, body.position.z, yaw, surface);
    if (!hit) continue;
    if (allowWalkableFollow
        && canReachWalkableHullAt(surface, walkableTargetX, walkableTargetZ, body.position.y, yaw)) continue;
    const hitX = fromX + (body.position.x - fromX) * hit.time;
    const hitZ = fromZ + (body.position.z - fromZ) * hit.time;
    if (surface.hull.triangles?.length) {
      const walkableSupport = walkableHullSupport(surface, body.position.x, body.position.z, yaw);
      if (allowWalkableFollow && walkableSupport
          && Math.abs(body.position.y - walkableSupport.height) <= SURFACE_HEIGHT_EPSILON) continue;
      const contactDistance = playerContactDistance(yaw, hit.normalX, hit.normalZ);
      const contactTop = worldHullHeightAt(
        surface.hull,
        hitX - hit.normalX * contactDistance,
        hitZ - hit.normalZ * contactDistance
      );
      if (contactTop !== undefined && body.position.y > contactTop + SURFACE_CLEARANCE) continue;
    }
    body.position.x = hitX;
    body.position.z = hitZ;
    const inwardVelocity = body.velocity.x * hit.normalX + body.velocity.z * hit.normalZ;
    if (inwardVelocity < 0) {
      body.velocity.x -= inwardVelocity * hit.normalX;
      body.velocity.z -= inwardVelocity * hit.normalZ;
    }
    collision ??= { surfaceId: surface.hull.id, normalX: hit.normalX, normalZ: hit.normalZ };
  }
  return collision;
}

function depenetrateBody(body: PhysicsBody, yaw: number): void {
  const extentX = playerContactDistance(yaw, 1, 0);
  const extentZ = playerContactDistance(yaw, 0, 1);
  for (const box of WORLD_BOXES) {
    if (!box.solid) continue;
    const top = box.position[1] + box.size[1] / 2;
    if (body.position.y > top - 0.1) continue;

    const minX = box.position[0] - box.size[0] / 2 - extentX;
    const maxX = box.position[0] + box.size[0] / 2 + extentX;
    const minZ = box.position[2] - box.size[2] / 2 - extentZ;
    const maxZ = box.position[2] + box.size[2] / 2 + extentZ;
    if (body.position.x <= minX || body.position.x >= maxX || body.position.z <= minZ || body.position.z >= maxZ) continue;

    const candidates = [
      { distance: body.position.x - minX, axis: "x" as const, value: minX },
      { distance: maxX - body.position.x, axis: "x" as const, value: maxX },
      { distance: body.position.z - minZ, axis: "z" as const, value: minZ },
      { distance: maxZ - body.position.z, axis: "z" as const, value: maxZ }
    ];
    const nearest = candidates.reduce((best, candidate) => candidate.distance < best.distance ? candidate : best);
    body.position[nearest.axis] = nearest.value;
    body.velocity[nearest.axis] = 0;
  }
  for (let pass = 0; pass < HULL_DEPENETRATION_PASSES; pass += 1) {
    let moved = false;
    for (const surface of HULL_SURFACES) moved = depenetrateFromHull(body, yaw, surface) || moved;
    if (!moved) break;
  }
}

function sweepExpandedHull(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  yaw: number,
  surface: HullSurface
): { time: number; normalX: number; normalZ: number } | undefined {
  const deltaX = toX - fromX;
  const deltaZ = toZ - fromZ;
  if (Math.hypot(deltaX, deltaZ) <= Number.EPSILON || surface.points.length < 3) return undefined;
  const extentX = playerContactDistance(yaw, 1, 0);
  const extentZ = playerContactDistance(yaw, 0, 1);
  if (Math.max(fromX, toX) + extentX < surface.minX
      || Math.min(fromX, toX) - extentX > surface.maxX
      || Math.max(fromZ, toZ) + extentZ < surface.minZ
      || Math.min(fromZ, toZ) - extentZ > surface.maxZ) return undefined;
  let enter = 0;
  let exit = 1;
  let enterNormalX = 0;
  let enterNormalZ = 0;
  for (let index = 0; index < surface.points.length; index += 1) {
    const start = surface.points[index]!;
    const end = surface.points[(index + 1) % surface.points.length]!;
    const edge = normalizedHullEdge(start, end);
    if (!edge) continue;
    const limit = start[0] * edge.normalX + start[1] * edge.normalZ
      + playerContactDistance(yaw, edge.normalX, edge.normalZ);
    const distance = fromX * edge.normalX + fromZ * edge.normalZ - limit;
    const rate = deltaX * edge.normalX + deltaZ * edge.normalZ;
    if (Math.abs(rate) <= 1e-9) {
      if (distance > 0) return undefined;
      continue;
    }
    const crossing = -distance / rate;
    if (rate < 0 && crossing > enter) {
      enter = crossing;
      enterNormalX = edge.normalX;
      enterNormalZ = edge.normalZ;
    } else if (rate > 0) {
      exit = Math.min(exit, crossing);
    }
    if (enter > exit) return undefined;
  }
  if (enter < -1e-7 || enter > 1 + 1e-7 || enter > exit || (enterNormalX === 0 && enterNormalZ === 0)) return undefined;
  return { time: clamp(enter, 0, 1), normalX: enterNormalX, normalZ: enterNormalZ };
}

/** Exposed for focused tests and tooling that preview authoritative hull contact. */
export function sweepWorldHull(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  yaw: number,
  hull: WorldHull
): { time: number; normalX: number; normalZ: number } | undefined {
  return sweepExpandedHull(fromX, fromZ, toX, toZ, yaw, makeHullSurface(hull));
}

/** Exposed for regression tests and authoritative collision previews. */
export function resolveWorldHullPenetration(body: PhysicsBody, yaw: number, hull: WorldHull): boolean {
  const surface = makeHullSurface(hull);
  let movedAny = false;
  for (let pass = 0; pass < HULL_DEPENETRATION_PASSES; pass += 1) {
    const moved = depenetrateFromHull(body, yaw, surface);
    movedAny = moved || movedAny;
    if (!moved) break;
  }
  return movedAny;
}

function depenetrateFromHull(body: PhysicsBody, yaw: number, surface: HullSurface): boolean {
  if (body.position.y > surface.maxY - 0.1 || body.position.y + CLING_BODY_HEIGHT < surface.minY + 0.1) return false;
  if (!footprintOverlapsHullAt(body.position.x, body.position.z, yaw, surface, 0)) return false;
  const localTop = hullSupportTop(surface, body.position.x, body.position.z, yaw);
  if (localTop !== undefined && body.position.y >= localTop - SURFACE_HEIGHT_EPSILON) return false;
  const horizontalSpeed = Math.hypot(body.velocity.x, body.velocity.z);
  if (horizontalSpeed > Number.EPSILON
      && canReachWalkableHullAt(
        surface,
        body.position.x + body.velocity.x / horizontalSpeed * WALKABLE_SURFACE_PROBE,
        body.position.z + body.velocity.z / horizontalSpeed * WALKABLE_SURFACE_PROBE,
        body.position.y,
        yaw
      )) return false;
  let nearestDistance = -Infinity;
  let nearestNormalX = 0;
  let nearestNormalZ = 0;
  for (let index = 0; index < surface.points.length; index += 1) {
    const start = surface.points[index]!;
    const end = surface.points[(index + 1) % surface.points.length]!;
    const edge = normalizedHullEdge(start, end);
    if (!edge) continue;
    const limit = start[0] * edge.normalX + start[1] * edge.normalZ
      + playerContactDistance(yaw, edge.normalX, edge.normalZ);
    const distance = body.position.x * edge.normalX + body.position.z * edge.normalZ - limit;
    if (distance > 0) return false;
    if (distance <= nearestDistance) continue;
    nearestDistance = distance;
    nearestNormalX = edge.normalX;
    nearestNormalZ = edge.normalZ;
  }
  if (nearestNormalX === 0 && nearestNormalZ === 0) return false;
  if (nearestDistance >= -HULL_DEPENETRATION_EPSILON) return false;
  body.position.x -= nearestDistance * nearestNormalX;
  body.position.z -= nearestDistance * nearestNormalZ;
  const inwardVelocity = body.velocity.x * nearestNormalX + body.velocity.z * nearestNormalZ;
  if (inwardVelocity < 0) {
    body.velocity.x -= inwardVelocity * nearestNormalX;
    body.velocity.z -= inwardVelocity * nearestNormalZ;
  }
  return true;
}

function normalizedHullEdge(
  start: readonly [number, number],
  end: readonly [number, number]
): { normalX: number; normalZ: number; tangentX: number; tangentZ: number } | undefined {
  const tangentX = end[0] - start[0];
  const tangentZ = end[1] - start[1];
  const length = Math.hypot(tangentX, tangentZ);
  if (length <= Number.EPSILON) return undefined;
  return {
    tangentX: tangentX / length,
    tangentZ: tangentZ / length,
    normalX: tangentZ / length,
    normalZ: -tangentX / length
  };
}

/** Project the oriented elliptical standing footprint onto a horizontal surface normal. */
export function playerContactDistance(yaw: number, normalX: number, normalZ: number): number {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const sideProjection = Math.abs(normalX * cos - normalZ * sin);
  const depthProjection = Math.abs(normalX * sin + normalZ * cos);
  return Math.hypot(
    sideProjection * GAME.playerHalfWidth,
    depthProjection * GAME.playerHalfDepth
  );
}

function worldLimit(yaw: number, normalX: number, normalZ: number, feetY: number): number {
  const innerWallFace = WORLD_SIZE / 2 - WORLD_WALL_THICKNESS / 2;
  const boundary = feetY >= ARENA_WALL_TOP - PLATFORM_EPSILON ? WORLD_SIZE / 2 : innerWallFace;
  return boundary - playerContactDistance(yaw, normalX, normalZ);
}

export function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

const CLING_LOST_DISTANCE = 0.8;
const CLING_DETACH_THRESHOLD = 0.55;
const CLING_EDGE_RELEASE_EPSILON = 0.001;
const CLING_BODY_HEIGHT = 2.3;
const CLING_MIN_OVERLAP = 0.28;
const MANTLE_TOP_INSET = 0.03;
const PLATFORM_EPSILON = 0.001;
// Vehicle hoods and normal ramps remain ground. Windshields and sides keep
// using the wall-climb path instead of automatically lifting the player.
const MIN_WALKABLE_NORMAL_Y = Math.cos(58 * Math.PI / 180);
const MAX_WALK_STEP_HEIGHT = 1.25;
const MAX_WALK_GROUND_SNAP = 0.55;
const WALKABLE_SURFACE_PROBE = 0.22;
const SURFACE_HEIGHT_EPSILON = 0.035;
const SURFACE_CLEARANCE = 0.02;
const WALKABLE_SUPPORT_CONTACT_EPSILON = 0.12;
const WALKABLE_GROUND_CONTACT_TOLERANCE = 0.28;
const HULL_DEPENETRATION_PASSES = 4;
const HULL_DEPENETRATION_EPSILON = 1e-7;
const ARENA_WALL_TOP = Math.max(
  ...WORLD_BOXES.filter((box) => box.kind === "wall").map((box) => box.position[1] + box.size[1] / 2)
);
