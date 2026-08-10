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
  private paintMode = false;
  private poseMenuHeld = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (event) => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight", "Digit1"].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (event.code === "Space" && !event.repeat) this.jumpQueued = true;
      if (event.code === "KeyR" && !event.repeat) {
        this.poseMenuHeld = true;
        this.onPoseMenuStart?.();
      }
      if (event.code === "KeyF" && !event.repeat) this.onTogglePaint?.();
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
      if (this.poseMenuHeld) {
        this.poseMenuHeld = false;
        this.onPoseMenuEnd?.();
      }
    });
    document.addEventListener("mousemove", (event) => {
      if (this.paintMode || document.pointerLockElement !== this.canvas) return;
      this.yaw = normalizeAngle(this.yaw - event.movementX * 0.0022);
      this.pitch = Math.max(-0.85, Math.min(0.48, this.pitch - event.movementY * 0.0018));
    });
    this.canvas.addEventListener("mousedown", (event) => {
      if (this.paintMode) return;
      event.preventDefault();
      if (document.pointerLockElement !== this.canvas) void this.canvas.requestPointerLock().catch(() => {});
      if (event.button === 0) this.onAction?.();
    });
  }

  snapshot(): InputPayload {
    if (this.paintMode) {
      this.jumpQueued = false;
      return { sequence: ++this.sequence, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: this.yaw };
    }
    const { forward, strafe, sprint } = this.movement();
    const jump = this.jumpQueued;
    const climbUp = this.keys.has("Space");
    const climbDown = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const climb = climbUp ? 1 : climbDown ? -1 : 0;
    this.jumpQueued = false;
    return { sequence: ++this.sequence, forward, strafe, jump, sprint, climb, detach: false, yaw: this.yaw };
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

  private faceCamera(): void {
    if (this.paintMode) return;
    this.yaw = normalizeAngle(this.yaw + this.cameraYawOffset);
    this.cameraYawOffset = 0;
  }
}

function normalizeAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

