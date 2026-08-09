import { GAME, WORLD_BOXES, WORLD_SIZE, WORLD_WALL_THICKNESS, clamp, type SurfaceClingState, type Vec3 } from "@mechfall/shared";

export interface PhysicsBody {
  position: Vec3;
  velocity: Vec3;
}

export type ClingMoveResult = "attached" | "released" | "mantled";

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
  if (!box || Math.abs(cling.normalX) + Math.abs(cling.normalZ) !== 1) return "released";
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

function canOccupyMantleTarget(surfaceId: string, x: number, z: number, feetY: number, yaw: number): boolean {
  for (const box of WORLD_BOXES) {
    if (!box.solid || box.id === surfaceId) continue;
    const bottom = box.position[1] - box.size[1] / 2;
    const top = box.position[1] + box.size[1] / 2;
    const verticallyBlocked = feetY < top - PLATFORM_EPSILON
      && feetY + CLING_BODY_HEIGHT > bottom + PLATFORM_EPSILON;
    if (verticallyBlocked && footprintOverlapsTopAt(x, z, yaw, box, PLATFORM_EPSILON)) return false;
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
