import { GAME, WORLD_BOXES, WORLD_SIZE, clamp, type Vec3 } from "@mechfall/shared";

export interface PhysicsBody {
  position: Vec3;
  velocity: Vec3;
}

export function moveBody(body: PhysicsBody, wishX: number, wishZ: number, speed: number, jump: boolean, dt: number): void {
  const length = Math.hypot(wishX, wishZ);
  const normalizedX = length > 1 ? wishX / length : wishX;
  const normalizedZ = length > 1 ? wishZ / length : wishZ;
  const response = 1 - Math.exp(-18 * dt);

  body.velocity.x += (normalizedX * speed - body.velocity.x) * response;
  body.velocity.z += (normalizedZ * speed - body.velocity.z) * response;

  const grounded = body.position.y <= 0.001;
  if (jump && grounded) body.velocity.y = GAME.jumpSpeed;
  body.velocity.y -= GAME.gravity * dt;

  moveAxis(body, "x", body.velocity.x * dt);
  moveAxis(body, "z", body.velocity.z * dt);
  body.position.y += body.velocity.y * dt;
  if (body.position.y < 0) {
    body.position.y = 0;
    body.velocity.y = 0;
  }

  const limit = WORLD_SIZE / 2 - 1;
  body.position.x = clamp(body.position.x, -limit, limit);
  body.position.z = clamp(body.position.z, -limit, limit);
}

function moveAxis(body: PhysicsBody, axis: "x" | "z", amount: number): void {
  body.position[axis] += amount;
  const radius = GAME.playerRadius;

  for (const box of WORLD_BOXES) {
    if (!box.solid) continue;
    const top = box.position[1] + box.size[1] / 2;
    if (body.position.y > top - 0.1) continue;

    const minX = box.position[0] - box.size[0] / 2 - radius;
    const maxX = box.position[0] + box.size[0] / 2 + radius;
    const minZ = box.position[2] - box.size[2] / 2 - radius;
    const maxZ = box.position[2] + box.size[2] / 2 + radius;
    if (body.position.x <= minX || body.position.x >= maxX || body.position.z <= minZ || body.position.z >= maxZ) continue;

    if (axis === "x") {
      body.position.x = amount > 0 ? minX : maxX;
      body.velocity.x = 0;
    } else {
      body.position.z = amount > 0 ? minZ : maxZ;
      body.velocity.z = 0;
    }
  }
}

export function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
