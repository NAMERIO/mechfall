import type { InputPayload } from "@mechfall/shared";

export class InputController {
  readonly keys = new Set<string>();
  yaw = Math.PI;
  pitch = -0.22;
  cameraYawOffset = 0;
  cameraPitchOffset = 0;
  sequence = 0;
  private jumpQueued = false;
  onAction?: () => void;
  onPose?: () => void;
  onTogglePoses?: () => void;
  onPoseMenuStart?: () => void;
  onPoseMenuEnd?: () => void;
  onWhistle?: () => void;
  onTogglePaint?: () => void;
  onToggleCollisionDebug?: () => void;
  private paintMode = false;
  private poseMenuHeld = false;
  private freeLookHeld = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (event) => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight", "Digit1", "F7"].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (event.code === "Space" && !event.repeat) this.jumpQueued = true;
      if (event.code === "KeyR" && !event.repeat) {
        this.poseMenuHeld = true;
        this.onPoseMenuStart?.();
      }
      if (event.code === "KeyF" && !event.repeat) this.onTogglePaint?.();
      if (event.code === "F7" && !event.repeat) this.onToggleCollisionDebug?.();
      if (event.code === "Digit1" && !event.repeat) this.onWhistle?.();
      if (event.code === "KeyV" && !event.repeat) this.faceCamera();
      if (event.code === "Escape" && document.pointerLockElement === this.canvas) document.exitPointerLock();
    });
    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
      if (event.code === "KeyR" && this.poseMenuHeld) {
        this.poseMenuHeld = false;
        this.onPoseMenuEnd?.();
      }
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.jumpQueued = false;
      this.freeLookHeld = false;
      if (this.poseMenuHeld) {
        this.poseMenuHeld = false;
        this.onPoseMenuEnd?.();
      }
    });
    document.addEventListener("mousemove", (event) => {
      if (this.paintMode || document.pointerLockElement !== this.canvas) return;
      if (this.freeLookHeld) {
        this.cameraYawOffset = normalizeAngle(this.cameraYawOffset - event.movementX * 0.0022);
        const cameraPitch = Math.max(
          -0.85,
          Math.min(0.48, this.pitch + this.cameraPitchOffset - event.movementY * 0.0018)
        );
        this.cameraPitchOffset = cameraPitch - this.pitch;
        return;
      }
      this.yaw = normalizeAngle(this.yaw - event.movementX * 0.0022);
      this.pitch = Math.max(-0.85, Math.min(0.48, this.pitch - event.movementY * 0.0018));
    });
    this.canvas.addEventListener("mousedown", (event) => {
      if (this.paintMode) return;
      event.preventDefault();
      if (document.pointerLockElement !== this.canvas) void this.canvas.requestPointerLock().catch(() => {});
      if (event.button === 2) this.freeLookHeld = true;
      if (event.button === 0) this.onAction?.();
    });
    window.addEventListener("mouseup", (event) => {
      if (event.button === 2) this.freeLookHeld = false;
    });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== this.canvas) this.freeLookHeld = false;
    });
  }

  snapshot(): InputPayload {
    if (this.paintMode) {
      this.jumpQueued = false;
      const aim = this.aim();
      return { sequence: ++this.sequence, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: this.yaw, aimYaw: aim.yaw, pitch: aim.pitch };
    }
    const { forward, strafe, sprint } = this.movement();
    const jump = this.jumpQueued;
    const climbUp = this.keys.has("Space");
    const climbDown = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const climb = climbUp ? 1 : climbDown ? -1 : 0;
    this.jumpQueued = false;
    const aim = this.aim();
    return { sequence: ++this.sequence, forward, strafe, jump, sprint, climb, detach: false, yaw: this.yaw, aimYaw: aim.yaw, pitch: aim.pitch };
  }

  movement(): { forward: number; strafe: number; sprint: boolean } {
    if (this.paintMode) return { forward: 0, strafe: 0, sprint: false };
    const forward = Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const strafe = Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    return { forward, strafe, sprint };
  }

  aim(): { yaw: number; pitch: number } {
    return {
      yaw: normalizeAngle(this.yaw + this.cameraYawOffset),
      pitch: Math.max(-0.85, Math.min(0.48, this.pitch + this.cameraPitchOffset))
    };
  }

  setPaintMode(active: boolean): void {
    this.paintMode = active;
    this.keys.clear();
    this.jumpQueued = false;
    if (active && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  updateCamera(dt: number): void {
    if (this.freeLookHeld) return;
    const response = 1 - Math.exp(-FREE_LOOK_RECENTER_RESPONSE * dt);
    this.cameraYawOffset *= 1 - response;
    this.cameraPitchOffset *= 1 - response;
    if (Math.abs(this.cameraYawOffset) < 0.0001) this.cameraYawOffset = 0;
    if (Math.abs(this.cameraPitchOffset) < 0.0001) this.cameraPitchOffset = 0;
  }

  private faceCamera(): void {
    if (this.paintMode) return;
    this.yaw = normalizeAngle(this.yaw + this.cameraYawOffset);
    this.cameraYawOffset = 0;
  }
}

const FREE_LOOK_RECENTER_RESPONSE = 9;

function normalizeAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

