import RAPIER from "@dimforge/rapier3d-compat";
import { GAME, WORLD_MODELS, WORLD_SIZE, type SurfaceClingState, type Vec3 } from "@mechfall/shared";
import bunkerManifest from "../../../client/public/models/maps/bunker.compound-colliders.json" with { type: "json" };

await RAPIER.init();

interface PhysicsBody {
  position: Vec3;
  velocity: Vec3;
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
  triangles?: readonly (readonly [number, number, number])[];
}

interface CompoundManifest {
  visualCenter?: readonly [number, number, number];
  colliders: readonly ManifestCollider[];
}

const manifest = bunkerManifest as unknown as CompoundManifest;

const PLAYER_HEIGHT = 2.3;
const PLAYER_RADIUS = 0.38;
const PLAYER_CAPSULE_HALF_HEIGHT = (PLAYER_HEIGHT - PLAYER_RADIUS * 2) / 2;
const PLAYER_CENTER_HEIGHT = PLAYER_HEIGHT / 2;
const CONTROLLER_OFFSET = 0.035;
const GROUND_PROBE = 0.11;
const MAX_WALK_SLOPE = 58 * Math.PI / 180;
const MAX_STEP_HEIGHT = 1.25;
const GROUND_SNAP_DISTANCE = 0.55;
const CLING_PROBE_DISTANCE = 0.16;
const OPEN_CENTER_DOOR_WALL_SOURCE = "Wall.020__part_0055";
const MANTLE_DURATION = 0.48;
const MANTLE_INWARD_SPEED = GAME.climbSpeed * 0.72;
const MANTLE_UP_SPEED = GAME.climbSpeed * 0.18;
const MANTLE_STATE_TIMEOUT_MS = 120;

interface MantleTransition {
  surfaceId: string;
  normalX: number;
  normalZ: number;
  remaining: number;
  updatedAt: number;
}

const mantleTransitions = new WeakMap<PhysicsBody, MantleTransition>();

const model = WORLD_MODELS.find((candidate) => candidate.id === "bunker");
export const hasCompoundWorldCollision = model !== undefined && manifest.colliders.length > 0;

const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
const surfaceIds = new Map<number, string>();
const characterController = world.createCharacterController(CONTROLLER_OFFSET);
characterController.setSlideEnabled(true);
characterController.enableAutostep(MAX_STEP_HEIGHT, PLAYER_RADIUS * 0.65, false);
characterController.enableSnapToGround(GROUND_SNAP_DISTANCE);
characterController.setMaxSlopeClimbAngle(MAX_WALK_SLOPE);
characterController.setMinSlopeSlideAngle(MAX_WALK_SLOPE + 0.08);

const characterCollider = world.createCollider(
  RAPIER.ColliderDesc.capsule(PLAYER_CAPSULE_HALF_HEIGHT, PLAYER_RADIUS)
);

if (model) buildCompoundMap(model);
buildArenaSafetyCollision();
world.step();

export function moveBodyWithRapier(
  body: PhysicsBody,
  wishX: number,
  wishZ: number,
  speed: number,
  jump: boolean,
  _yaw: number,
  dt: number
): SurfaceClingState | undefined {
  const length = Math.hypot(wishX, wishZ);
  const normalizedX = length > 1 ? wishX / length : wishX;
  const normalizedZ = length > 1 ? wishZ / length : wishZ;
  const response = 1 - Math.exp(-18 * dt);
  body.velocity.x += (normalizedX * speed - body.velocity.x) * response;
  body.velocity.z += (normalizedZ * speed - body.velocity.z) * response;

  const grounded = probeGround(body.position);
  if (jump && grounded) body.velocity.y = GAME.jumpSpeed;
  body.velocity.y -= GAME.gravity * dt;

  setCharacterPosition(body.position);
  const desired = {
    x: body.velocity.x * dt,
    y: body.velocity.y * dt,
    z: body.velocity.z * dt
  };
  characterController.computeColliderMovement(characterCollider, desired, undefined, undefined, excludeCharacter);
  const movement = characterController.computedMovement();
  const collision = horizontalClingCollision();

  body.position.x += movement.x;
  body.position.y += movement.y;
  body.position.z += movement.z;
  if (dt > 0) {
    if (Math.abs(movement.x - desired.x) > 1e-4) body.velocity.x = movement.x / dt;
    if (Math.abs(movement.y - desired.y) > 1e-4) body.velocity.y = movement.y / dt;
    if (Math.abs(movement.z - desired.z) > 1e-4) body.velocity.z = movement.z / dt;
  }
  if (body.position.y < 0) {
    body.position.y = 0;
    body.velocity.y = Math.max(0, body.velocity.y);
  }
  return collision;
}

export function isCompoundCollisionSurface(surfaceId: string): boolean {
  for (const id of surfaceIds.values()) if (id === surfaceId) return true;
  return false;
}

export function moveClingingBodyWithRapier(
  body: PhysicsBody,
  cling: SurfaceClingState,
  sideways: number,
  vertical: number,
  dt: number
): "attached" | "released" | "mantled" {
  const now = Date.now();
  const activeTransition = mantleTransitions.get(body);
  if (activeTransition) {
    if (activeTransition.surfaceId === cling.surfaceId
        && now - activeTransition.updatedAt <= MANTLE_STATE_TIMEOUT_MS) {
      return advanceMantleTransition(body, activeTransition, dt, now);
    }
    mantleTransitions.delete(body);
  }
  const horizontalLength = Math.hypot(cling.normalX, cling.normalZ);
  if (horizontalLength < 0.5) return "released";
  const normalX = cling.normalX / horizontalLength;
  const normalZ = cling.normalZ / horizontalLength;
  const tangentX = normalZ;
  const tangentZ = -normalX;
  const sideSpeed = Math.max(-1, Math.min(1, sideways)) * GAME.climbSpeed;
  const climbSpeed = Math.max(-1, Math.min(1, vertical)) * GAME.climbSpeed;
  const desired = {
    x: tangentX * sideSpeed * dt,
    y: climbSpeed * dt,
    z: tangentZ * sideSpeed * dt
  };

  setCharacterPosition(body.position);
  computeClimbingMovement(desired);
  const movement = characterController.computedMovement();
  const previous = { ...body.position };
  body.position.x += movement.x;
  body.position.y += movement.y;
  body.position.z += movement.z;

  if (!touchesSurface(body.position, cling.surfaceId, normalX, normalZ)) {
    if (vertical > 0.1 && dt > 0) {
      const transition: MantleTransition = {
        surfaceId: cling.surfaceId,
        normalX,
        normalZ,
        remaining: MANTLE_DURATION,
        updatedAt: now
      };
      mantleTransitions.set(body, transition);
      updateVelocityFromMovement(body, movement, dt);
      return "attached";
    }
    body.position.x = previous.x;
    body.position.y = previous.y;
    body.position.z = previous.z;
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    return "released";
  }

  updateVelocityFromMovement(body, movement, dt);
  return "attached";
}

function advanceMantleTransition(
  body: PhysicsBody,
  transition: MantleTransition,
  dt: number,
  now: number
): "attached" | "mantled" {
  if (dt <= 0) return "attached";
  setCharacterPosition(body.position);
  const desired = {
    x: -transition.normalX * MANTLE_INWARD_SPEED * dt,
    y: MANTLE_UP_SPEED * dt,
    z: -transition.normalZ * MANTLE_INWARD_SPEED * dt
  };
  computeClimbingMovement(desired);
  const movement = characterController.computedMovement();
  body.position.x += movement.x;
  body.position.y += movement.y;
  body.position.z += movement.z;
  updateVelocityFromMovement(body, movement, dt);
  transition.remaining -= dt;
  transition.updatedAt = now;
  if (transition.remaining > 0) return "attached";
  mantleTransitions.delete(body);
  body.velocity.x = 0;
  body.velocity.y = 0;
  body.velocity.z = 0;
  return "mantled";
}

function updateVelocityFromMovement(body: PhysicsBody, movement: RAPIER.Vector, dt: number): void {
  if (dt > 0) {
    body.velocity.x = movement.x / dt;
    body.velocity.y = movement.y / dt;
    body.velocity.z = movement.z / dt;
  } else {
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
  }
}

function computeClimbingMovement(desired: RAPIER.Vector): void {
  characterController.disableAutostep();
  characterController.disableSnapToGround();
  try {
    characterController.computeColliderMovement(characterCollider, desired, undefined, undefined, excludeCharacter);
  } finally {
    characterController.enableAutostep(MAX_STEP_HEIGHT, PLAYER_RADIUS * 0.65, false);
    characterController.enableSnapToGround(GROUND_SNAP_DISTANCE);
  }
}

function probeGround(position: Vec3): boolean {
  setCharacterPosition(position);
  characterController.computeColliderMovement(
    characterCollider,
    { x: 0, y: -GROUND_PROBE, z: 0 },
    undefined,
    undefined,
    excludeCharacter
  );
  if (characterController.computedGrounded()) return true;
  for (let index = 0; index < characterController.numComputedCollisions(); index += 1) {
    const collision = characterController.computedCollision(index);
    if (collision && collision.normal1.y > 0.65) return true;
  }
  return position.y <= 0.001;
}

function horizontalClingCollision(): SurfaceClingState | undefined {
  let strongest: SurfaceClingState | undefined;
  let strength = 0;
  for (let index = 0; index < characterController.numComputedCollisions(); index += 1) {
    const collision = characterController.computedCollision(index);
    if (!collision?.collider) continue;
    const id = surfaceIds.get(collision.collider.handle);
    if (!id) continue;
    const horizontal = Math.hypot(collision.normal1.x, collision.normal1.z);
    if (horizontal < 0.65 || horizontal <= strength) continue;
    strength = horizontal;
    strongest = {
      surfaceId: id,
      normalX: collision.normal1.x / horizontal,
      normalZ: collision.normal1.z / horizontal
    };
  }
  return strongest;
}

function touchesSurface(position: Vec3, surfaceId: string, normalX: number, normalZ: number): boolean {
  setCharacterPosition(position);
  computeClimbingMovement({ x: -normalX * CLING_PROBE_DISTANCE, y: 0, z: -normalZ * CLING_PROBE_DISTANCE });
  for (let index = 0; index < characterController.numComputedCollisions(); index += 1) {
    const collision = characterController.computedCollision(index);
    if (collision?.collider && surfaceIds.get(collision.collider.handle) === surfaceId) return true;
  }
  return false;
}

function setCharacterPosition(feet: Vec3): void {
  characterCollider.setTranslation({ x: feet.x, y: feet.y + PLAYER_CENTER_HEIGHT, z: feet.z });
}

function excludeCharacter(collider: RAPIER.Collider): boolean {
  return collider.handle !== characterCollider.handle;
}

function buildCompoundMap(worldModel: NonNullable<typeof model>): void {
  const modelRotation = quaternionFromEuler(worldModel.rotation);
  const center = manifest.visualCenter ?? [0, 0, 0];
  for (const entry of manifest.colliders) {
    if (entry.source === OPEN_CENTER_DOOR_WALL_SOURCE && entry.halfExtents) {
      buildWallAroundCenterDoor(entry, worldModel, modelRotation, center);
      continue;
    }
    const descriptor = colliderDescriptor(entry, worldModel.scale);
    if (!descriptor) continue;
    placeManifestCollider(descriptor, entry, worldModel, modelRotation, center, [0, 0, 0], entry.id);
  }
}

/**
 * This generated panel spans across both the concrete wall and its visible
 * double-door opening. Preserve the wall beside and above the doorway while
 * leaving the lower half of the door section passable.
 */
function buildWallAroundCenterDoor(
  entry: ManifestCollider,
  worldModel: NonNullable<typeof model>,
  modelRotation: Quaternion,
  center: readonly [number, number, number]
): void {
  const [halfX, halfY, halfZ] = entry.halfExtents!;
  const sideHalfZ = halfZ / 2;
  const lintelHalfY = halfY / 2;
  const side = RAPIER.ColliderDesc.cuboid(
    halfX * Math.abs(worldModel.scale[0]),
    halfY * Math.abs(worldModel.scale[1]),
    sideHalfZ * Math.abs(worldModel.scale[2])
  );
  placeManifestCollider(
    side,
    entry,
    worldModel,
    modelRotation,
    center,
    [0, 0, sideHalfZ],
    `${entry.id}:side`
  );

  const lintel = RAPIER.ColliderDesc.cuboid(
    halfX * Math.abs(worldModel.scale[0]),
    lintelHalfY * Math.abs(worldModel.scale[1]),
    sideHalfZ * Math.abs(worldModel.scale[2])
  );
  placeManifestCollider(
    lintel,
    entry,
    worldModel,
    modelRotation,
    center,
    [0, lintelHalfY, -sideHalfZ],
    `${entry.id}:lintel`
  );
}

function placeManifestCollider(
  descriptor: RAPIER.ColliderDesc,
  entry: ManifestCollider,
  worldModel: NonNullable<typeof model>,
  modelRotation: Quaternion,
  center: readonly [number, number, number],
  localOffset: readonly [number, number, number],
  surfaceId: string
): void {
  const centered: [number, number, number] = [
    (entry.translation[0] - center[0]) * worldModel.scale[0],
    (entry.translation[1] - center[1]) * worldModel.scale[1],
    (entry.translation[2] - center[2]) * worldModel.scale[2]
  ];
  const translated = rotateVector(centered, modelRotation);
  const rotation = multiplyQuaternions(modelRotation, entry.rotation);
  const scaledOffset: [number, number, number] = [
    localOffset[0] * worldModel.scale[0],
    localOffset[1] * worldModel.scale[1],
    localOffset[2] * worldModel.scale[2]
  ];
  const offset = rotateVector(scaledOffset, rotation);
  descriptor
    .setTranslation(
      worldModel.position[0] + translated[0] + offset[0],
      worldModel.position[1] + translated[1] + offset[1],
      worldModel.position[2] + translated[2] + offset[2]
    )
    .setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] });
  const collider = world.createCollider(descriptor);
  surfaceIds.set(collider.handle, surfaceId);
}

function colliderDescriptor(entry: ManifestCollider, scale: readonly [number, number, number]): RAPIER.ColliderDesc | null {
  if (entry.type === "box" && entry.halfExtents) {
    return RAPIER.ColliderDesc.cuboid(
      entry.halfExtents[0] * Math.abs(scale[0]),
      entry.halfExtents[1] * Math.abs(scale[1]),
      entry.halfExtents[2] * Math.abs(scale[2])
    );
  }
  if (entry.type === "cylinder" && entry.radius !== undefined && entry.halfHeight !== undefined) {
    const radialScale = Math.max(Math.abs(scale[0]), Math.abs(scale[2]));
    return RAPIER.ColliderDesc.cylinder(entry.halfHeight * Math.abs(scale[1]), entry.radius * radialScale);
  }
  if (entry.type === "convex" && entry.points) {
    const points = new Float32Array(entry.points.flatMap((point) => [
      point[0] * scale[0], point[1] * scale[1], point[2] * scale[2]
    ]));
    return RAPIER.ColliderDesc.convexHull(points);
  }
  if (entry.type === "mesh" && entry.points && entry.triangles) {
    const points = new Float32Array(entry.points.flatMap((point) => [
      point[0] * scale[0], point[1] * scale[1], point[2] * scale[2]
    ]));
    return RAPIER.ColliderDesc.trimesh(
      points,
      new Uint32Array(entry.triangles.flat()),
      RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES
    );
  }
  return null;
}

function buildArenaSafetyCollision(): void {
  const half = WORLD_SIZE / 2;
  const thickness = 1;
  const height = 12;
  const floor = world.createCollider(
    RAPIER.ColliderDesc.cuboid(half, 0.1, half).setTranslation(0, -0.1, 0)
  );
  surfaceIds.set(floor.handle, "arena-floor");
  for (const [id, x, z, halfX, halfZ] of [
    ["arena-west", -half, 0, thickness / 2, half],
    ["arena-east", half, 0, thickness / 2, half],
    ["arena-north", 0, -half, half, thickness / 2],
    ["arena-south", 0, half, half, thickness / 2]
  ] as const) {
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfX, height / 2, halfZ).setTranslation(x, height / 2, z)
    );
    surfaceIds.set(collider.handle, id);
  }
}

function quaternionFromEuler([x, y, z]: readonly [number, number, number]): Quaternion {
  const c1 = Math.cos(x / 2); const c2 = Math.cos(y / 2); const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2); const s2 = Math.sin(y / 2); const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3
  ];
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

function rotateVector(vector: readonly [number, number, number], quaternion: Quaternion): [number, number, number] {
  const [x, y, z] = vector;
  const [qx, qy, qz, qw] = quaternion;
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
