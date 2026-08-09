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
  onWhistle?: () => void;
  onTogglePaint?: () => void;
  onEyedropper?: () => void;
  private paintMode = false;
  private freeLooking = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (event) => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (event.code === "Space" && !event.repeat) this.jumpQueued = true;
      if (event.code === "KeyC" && !event.repeat) this.onPose?.();
      if (event.code === "KeyR" && !event.repeat) this.onTogglePoses?.();
      if (event.code === "KeyF" && !event.repeat) this.onTogglePaint?.();
      if (event.code === "KeyE" && !event.repeat) this.onEyedropper?.();
      if (event.code === "KeyQ" && !event.repeat) this.onWhistle?.();
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.freeLooking = false;
    });
    document.addEventListener("mousemove", (event) => {
      if (document.pointerLockElement !== this.canvas) return;
      if (this.freeLooking) {
        this.cameraYawOffset = normalizeAngle(this.cameraYawOffset - event.movementX * 0.0022);
        const cameraPitch = Math.max(-0.85, Math.min(0.48, this.pitch + this.cameraPitchOffset - event.movementY * 0.0018));
        this.cameraPitchOffset = cameraPitch - this.pitch;
        return;
      }
      this.yaw = normalizeAngle(this.yaw - event.movementX * 0.0022);
      this.pitch = Math.max(-0.85, Math.min(0.48, this.pitch - event.movementY * 0.0018));
    });
    this.canvas.addEventListener("mousedown", (event) => {
      if (this.paintMode) return;
      if (event.button === 2) {
        event.preventDefault();
        this.freeLooking = true;
        if (document.pointerLockElement !== this.canvas) void this.canvas.requestPointerLock();
        return;
      }
      if (event.button !== 0) return;
      if (document.pointerLockElement !== this.canvas) {
        void this.canvas.requestPointerLock();
      } else if (!this.freeLooking) {
        this.onAction?.();
      }
    });
    window.addEventListener("mouseup", (event) => {
      if (event.button === 2) this.freeLooking = false;
    });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== this.canvas) {
        this.freeLooking = false;
        this.cameraYawOffset = 0;
        this.cameraPitchOffset = 0;
      }
    });
  }

  snapshot(): InputPayload {
    if (this.paintMode) {
      this.jumpQueued = false;
      return { sequence: ++this.sequence, forward: 0, strafe: 0, jump: false, sprint: false, yaw: this.yaw };
    }
    const forward = Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const strafe = Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    const jump = this.jumpQueued;
    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    this.jumpQueued = false;
    return { sequence: ++this.sequence, forward, strafe, jump, sprint, yaw: this.yaw };
  }

  aim(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  updateCamera(dt: number): void {
    if (this.freeLooking) return;
    const recenter = Math.exp(-9 * dt);
    this.cameraYawOffset *= recenter;
    this.cameraPitchOffset *= recenter;
    if (Math.abs(this.cameraYawOffset) < 0.0001) this.cameraYawOffset = 0;
    if (Math.abs(this.cameraPitchOffset) < 0.0001) this.cameraPitchOffset = 0;
  }

  setPaintMode(active: boolean): void {
    this.paintMode = active;
    this.freeLooking = false;
    this.cameraYawOffset = 0;
    this.cameraPitchOffset = 0;
    this.keys.clear();
    this.jumpQueued = false;
    if (active && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}

function normalizeAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}
