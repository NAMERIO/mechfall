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

export interface PhysicsBody {
  position: Vec3;
  velocity: Vec3;
}

export type ClingMoveResult = "attached" | "released" | "mantled";

interface HullSurface {
  hull: WorldHull;
  points: readonly (readonly [number, number])[];
  minY: number;
  maxY: number;
}

const HULL_SURFACES: readonly HullSurface[] = WORLD_HULLS
  .filter((hull) => hull.solid && hull.vertices.length >= 4)
  .map((hull) => ({ hull, ...worldHullFootprint(hull) }));

export function moveBody(
  body: PhysicsBody,
  wishX: number,
  wishZ: number,
  speed: number,
  jump: boolean,
  yaw: number,
  dt: number
): SurfaceClingState | undefined {
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
  const xCollision = moveAxis(body, "x", body.velocity.x * dt, yaw);
  const zCollision = moveAxis(body, "z", body.velocity.z * dt, yaw);
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
  let matched: { start: readonly [number, number]; end: readonly [number, number]; normalX: number; normalZ: number } | undefined;
  for (let index = 0; index < surface.points.length; index += 1) {
    const start = surface.points[index]!;
    const end = surface.points[(index + 1) % surface.points.length]!;
    const edge = normalizedHullEdge(start, end);
    if (!edge || edge.normalX * cling.normalX + edge.normalZ * cling.normalZ < 0.999) continue;
    matched = { start, end, normalX: edge.normalX, normalZ: edge.normalZ };
    break;
  }
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
    if (!footprintOverlapsHullAt(body.position.x, body.position.z, yaw, surface, PLATFORM_EPSILON)) continue;
    const top = hullSupportTop(surface, body.position.x, body.position.z, yaw);
    if (top !== undefined && Math.abs(body.position.y - top) <= PLATFORM_EPSILON) return true;
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
  if (!surface.hull.triangles?.length) return surface.maxY;
  const extentX = playerContactDistance(yaw, 1, 0);
  const extentZ = playerContactDistance(yaw, 0, 1);
  const samples = [
    [x, z],
    [x - extentX * 0.8, z], [x + extentX * 0.8, z],
    [x, z - extentZ * 0.8], [x, z + extentZ * 0.8],
    [x - extentX * 0.55, z - extentZ * 0.55], [x + extentX * 0.55, z - extentZ * 0.55],
    [x - extentX * 0.55, z + extentZ * 0.55], [x + extentX * 0.55, z + extentZ * 0.55]
  ] as const;
  let highest = -Infinity;
  for (const sample of samples) {
    const height = worldHullHeightAt(surface.hull, sample[0], sample[1]);
    if (height !== undefined) highest = Math.max(highest, height);
  }
  return highest > -Infinity ? highest : undefined;
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

function moveAxis(body: PhysicsBody, axis: "x" | "z", amount: number, yaw: number): SurfaceClingState | undefined {
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
  for (const surface of HULL_SURFACES) {
    if (body.position.y > surface.maxY - 0.1 || body.position.y + CLING_BODY_HEIGHT < surface.minY + 0.1) continue;
    const fromX = axis === "x" ? previous : body.position.x;
    const fromZ = axis === "z" ? previous : body.position.z;
    const hit = sweepExpandedHull(fromX, fromZ, body.position.x, body.position.z, yaw, surface);
    if (!hit) continue;
    const hitX = fromX + (body.position.x - fromX) * hit.time;
    const hitZ = fromZ + (body.position.z - fromZ) * hit.time;
    if (surface.hull.triangles?.length) {
      const contactDistance = playerContactDistance(yaw, hit.normalX, hit.normalZ);
      const contactTop = worldHullHeightAt(
        surface.hull,
        hitX - hit.normalX * contactDistance,
        hitZ - hit.normalZ * contactDistance
      );
      if (contactTop !== undefined && body.position.y > contactTop - 0.1) continue;
    }
    body.position.x = hitX;
    body.position.z = hitZ;
    body.velocity[axis] = 0;
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
  for (const surface of HULL_SURFACES) depenetrateFromHull(body, yaw, surface);
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
  const footprint = worldHullFootprint(hull);
  return sweepExpandedHull(fromX, fromZ, toX, toZ, yaw, { hull, ...footprint });
}

function depenetrateFromHull(body: PhysicsBody, yaw: number, surface: HullSurface): void {
  if (body.position.y > surface.maxY - 0.1 || body.position.y + CLING_BODY_HEIGHT < surface.minY + 0.1) return;
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
    if (distance > 0) return;
    if (distance <= nearestDistance) continue;
    nearestDistance = distance;
    nearestNormalX = edge.normalX;
    nearestNormalZ = edge.normalZ;
  }
  if (nearestNormalX === 0 && nearestNormalZ === 0) return;
  body.position.x -= nearestDistance * nearestNormalX;
  body.position.z -= nearestDistance * nearestNormalZ;
  const inwardVelocity = body.velocity.x * nearestNormalX + body.velocity.z * nearestNormalZ;
  if (inwardVelocity < 0) {
    body.velocity.x -= inwardVelocity * nearestNormalX;
    body.velocity.z -= inwardVelocity * nearestNormalZ;
  }
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
const ARENA_WALL_TOP = Math.max(
  ...WORLD_BOXES.filter((box) => box.kind === "wall").map((box) => box.position[1] + box.size[1] / 2)
);
