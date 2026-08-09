import type { InputPayload } from "@mechfall/shared";

export class InputController {
  readonly keys = new Set<string>();
  yaw = Math.PI;
  pitch = -0.22;
  sequence = 0;
  private jumpQueued = false;
  onAction?: () => void;
  onPose?: () => void;
  onTogglePoses?: () => void;
  onWhistle?: () => void;
  onTogglePaint?: () => void;
  onEyedropper?: () => void;
  private paintMode = false;

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
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("mousemove", (event) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw -= event.movementX * 0.0022;
      this.pitch = Math.max(-0.85, Math.min(0.48, this.pitch - event.movementY * 0.0018));
    });
    this.canvas.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (this.paintMode) return;
      if (document.pointerLockElement !== this.canvas) {
        void this.canvas.requestPointerLock();
      } else {
        this.onAction?.();
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

  setPaintMode(active: boolean): void {
    this.paintMode = active;
    this.keys.clear();
    this.jumpQueued = false;
    if (active && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}
