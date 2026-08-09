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
  private mouseMode?: "camera" | "body";
  private mouseButton?: 0 | 2;
  private mouseDownAt = 0;
  private mouseTravel = 0;
  private bodyFacingStarted = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (event) => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
      if (event.code === "Space" && !event.repeat) this.jumpQueued = true;
      if (event.code === "KeyC" && !event.repeat) this.onPose?.();
      if (event.code === "KeyR" && !event.repeat) this.onTogglePoses?.();
      if (event.code === "KeyF" && !event.repeat) this.onTogglePaint?.();
      if (event.code === "KeyE" && !event.repeat) this.onEyedropper?.();
      if (event.code === "KeyQ" && !event.repeat) this.onWhistle?.();
      if (event.code === "Escape") this.cancelMouseGesture();
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.jumpQueued = false;
      this.cancelMouseGesture();
    });
    document.addEventListener("mousemove", (event) => {
      if (!this.mouseMode) return;
      this.mouseTravel += Math.hypot(event.movementX, event.movementY);
      if (document.pointerLockElement !== this.canvas) return;
      if (this.mouseMode === "camera") {
        this.cameraYawOffset = normalizeAngle(this.cameraYawOffset - event.movementX * 0.0022);
        const cameraPitch = Math.max(-0.85, Math.min(0.48, this.pitch + this.cameraPitchOffset - event.movementY * 0.0018));
        this.cameraPitchOffset = cameraPitch - this.pitch;
        return;
      }
      if (!this.bodyFacingStarted) {
        if (this.mouseTravel <= MAX_CLICK_TRAVEL) return;
        this.yaw = normalizeAngle(this.yaw + this.cameraYawOffset);
        this.pitch = Math.max(-0.85, Math.min(0.48, this.pitch + this.cameraPitchOffset));
        this.cameraYawOffset = 0;
        this.cameraPitchOffset = 0;
        this.bodyFacingStarted = true;
      }
      this.yaw = normalizeAngle(this.yaw - event.movementX * 0.0022);
      this.pitch = Math.max(-0.85, Math.min(0.48, this.pitch - event.movementY * 0.0018));
    });
    this.canvas.addEventListener("mousedown", (event) => {
      if (this.paintMode || (event.button !== 0 && event.button !== 2)) return;
      event.preventDefault();
      if (this.mouseMode) return;
      this.mouseMode = event.button === 0 ? "body" : "camera";
      this.mouseButton = event.button;
      this.mouseDownAt = performance.now();
      this.mouseTravel = 0;
      this.bodyFacingStarted = false;
      if (document.pointerLockElement !== this.canvas) void this.canvas.requestPointerLock().catch(() => {});
    });
    window.addEventListener("mouseup", (event) => {
      if (event.button === this.mouseButton) this.finishMouseGesture(true);
    });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement === this.canvas && !this.mouseMode) document.exitPointerLock();
      if (document.pointerLockElement !== this.canvas && this.mouseMode) this.finishMouseGesture(false);
    });
  }

  snapshot(): InputPayload {
    if (this.paintMode) {
      this.jumpQueued = false;
      return { sequence: ++this.sequence, forward: 0, strafe: 0, jump: false, sprint: false, climb: 0, detach: false, yaw: this.yaw };
    }
    const forward = Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const strafe = Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    const jump = this.jumpQueued;
    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const climbUp = this.keys.has("Space");
    const climbDown = sprint;
    const climb = Number(climbUp) - Number(climbDown);
    this.jumpQueued = false;
    return { sequence: ++this.sequence, forward, strafe, jump, sprint, climb, detach: false, yaw: this.yaw };
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
    this.cancelMouseGesture();
  }

  private finishMouseGesture(allowAction: boolean): void {
    const mode = this.mouseMode;
    const shouldAct = allowAction
      && mode === "body"
      && performance.now() - this.mouseDownAt <= MAX_CLICK_DURATION_MS
      && this.mouseTravel <= MAX_CLICK_TRAVEL;
    this.mouseMode = undefined;
    this.mouseButton = undefined;
    this.mouseDownAt = 0;
    this.mouseTravel = 0;
    this.bodyFacingStarted = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (shouldAct) this.onAction?.();
  }

  private cancelMouseGesture(): void {
    this.finishMouseGesture(false);
  }
}

function normalizeAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

const MAX_CLICK_DURATION_MS = 250;
const MAX_CLICK_TRAVEL = 5;
