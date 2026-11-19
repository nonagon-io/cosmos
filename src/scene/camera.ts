import { MathUtils, PerspectiveCamera } from 'three';
import type { Vec } from '../astro/kepler';

export const MAX_DISTANCE = 2.5e6;
const ROTATE_PER_PX = 0.0055;
const ZOOM_PER_WHEEL = 0.0016;

interface Flight {
  from: () => Vec;
  // where the camera started, relative to the old focus
  offset: Vec;
  // the first look direction and how far away the old focus was
  dir0: Vec;
  l0: number;
  d1: number;
  t: number;
  duration: number;
  done?: () => void;
}

// share of the flight spent turning to face the target, and when the move toward it starts
const TURN_END = 0.4;
const MOVE_START = 0.25;
// in the chase view the camera sits a little above the line of travel so the body isn't edge-on to it
const CHASE_LIFT = 0.22;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
// how fast the chase camera may turn, in rad per real second; a heading that swings faster than
// CHASE_FREEZE (fast playback) is not followed at all, the camera holds still until it slows down
const CHASE_MAX_TURN = 1.2;
const CHASE_FREEZE: [number, number] = [0.6, 1.2];

const easeInOut = (s: number) => (s < 0.5 ? 4 * s ** 3 : 1 - (-2 * s + 2) ** 3 / 2);
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);

function slerp(a: Vec, b: Vec, s: number): Vec {
  const cos = MathUtils.clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const angle = Math.acos(cos);
  if (angle < 1e-6) {
    return b;
  }
  let axisB = b;
  if (Math.PI - angle < 1e-4) {
    // turning right around: go via a direction at right angles to a
    const side: Vec = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const d = side[0] * a[0] + side[1] * a[1] + side[2] * a[2];
    axisB = [side[0] - d * a[0], side[1] - d * a[1], side[2] - d * a[2]];
    const n = len(axisB);
    axisB = [axisB[0] / n, axisB[1] / n, axisB[2] / n];
    return s < 0.5 ? slerp(a, axisB, s * 2) : slerp(axisB, b, s * 2 - 1);
  }
  const sa = Math.sin((1 - s) * angle) / Math.sin(angle);
  const sb = Math.sin(s * angle) / Math.sin(angle);
  return [a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb];
}

/**
 * Orbit camera around a focus body. The scene is drawn relative to the focus (floating origin), so the
 * camera itself stays near the origin and float32 precision holds at any distance.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  focusId: string;
  distance: number;
  yaw = 0.6;
  pitch = 0.42;
  /** ecliptic position of the point the camera looks at */
  readonly focusPos: Vec = [0, 0, 0];
  private targetDistance: number;
  private yawVel = 0;
  private pitchVel = 0;
  private flight: Flight | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private downAt: { x: number; y: number; t: number } | null = null;
  private moved = false;
  private lastMove = 0;

  /** Keep the camera behind the focus, looking where it is heading. */
  chase = false;
  velocityOf: (id: string) => Vec | null = () => null;
  // the chase direction last frame; null while still easing round to it
  private chaseBase: [number, number] | null = null;
  private chaseTouched = false;
  // the true heading last frame and how fast it has been turning
  private chaseRaw: [number, number] | null = null;
  private chaseRate = 0;

  onClick: (x: number, y: number) => void = () => {};
  onDoubleClick: (x: number, y: number) => void = () => {};
  onUserMove: () => void = () => {};

  constructor(
    private readonly el: HTMLElement,
    focusId: string,
    distance: number,
    private readonly positionOf: (id: string) => Vec | null,
    private readonly minDistanceOf: (id: string) => number,
  ) {
    this.camera = new PerspectiveCamera(45, 1, 1e-9, 1e9);
    this.focusId = focusId;
    this.distance = this.targetDistance = distance;
    this.bindInput();
  }

  get flying() {
    return this.flight !== null;
  }

  /**
   * Flies to `id` and settles at `distance` AU from it: the camera first turns where it stands until the
   * target is dead ahead, then moves straight in.
   */
  flyTo(id: string, distance: number, done?: () => void) {
    const fromId = this.focusId;
    const start: Vec = [...this.focusPos];
    // follow wherever the old focus moves to during the flight
    const from = (): Vec => this.positionOf(fromId) ?? start;
    const d1 = Math.max(distance, this.minDistanceOf(id) * 1.6);
    const offset = this.offset(this.distance);
    const eye: Vec = [start[0] + offset[0], start[1] + offset[1], start[2] + offset[2]];
    const dir0: Vec = [-offset[0] / this.distance, -offset[1] / this.distance, -offset[2] / this.distance];
    const toEye = sub(this.positionOf(id) ?? start, eye);
    const l1 = Math.max(len(toEye), 1e-12);
    const dir1: Vec = [toEye[0] / l1, toEye[1] / l1, toEye[2] / l1];
    const turn = Math.acos(MathUtils.clamp(dir0[0] * dir1[0] + dir0[1] * dir1[1] + dir0[2] * dir1[2], -1, 1));
    const span = Math.abs(Math.log10(d1 / l1));
    this.yawVel = this.pitchVel = 0;
    this.chaseBase = null;
    this.chaseTouched = false;
    this.chaseRaw = null;
    this.flight = {
      from,
      offset,
      dir0,
      l0: this.distance,
      d1,
      t: 0,
      duration: MathUtils.clamp(1.1 + span * 0.42 + turn * 0.35, 1.1, 5.5),
      done,
    };
    this.focusId = id;
    this.targetDistance = d1;
  }

  /** Camera position relative to the focus, in ecliptic coordinates. */
  private offset(d: number): Vec {
    const cp = Math.cos(this.pitch);
    return [d * cp * Math.sin(this.yaw), -d * cp * Math.cos(this.yaw), d * Math.sin(this.pitch)];
  }

  private lookAlong(dir: Vec) {
    this.yaw = Math.atan2(-dir[0], dir[1]);
    this.pitch = MathUtils.clamp(Math.asin(MathUtils.clamp(-dir[2], -1, 1)), -1.55, 1.55);
  }

  setChase(on: boolean) {
    this.chase = on;
    this.chaseBase = null;
    this.chaseTouched = false;
    this.chaseRaw = null;
  }

  /** Puts the camera at a view at once, without a flight. */
  jumpTo(id: string, distance: number) {
    this.flight = null;
    this.focusId = id;
    this.distance = this.targetDistance = Math.max(distance, this.minDistanceOf(id) * 1.05);
  }

  zoomBy(factor: number) {
    this.targetDistance = MathUtils.clamp(
      this.targetDistance * factor,
      this.minDistanceOf(this.focusId) * 1.05,
      MAX_DISTANCE,
    );
  }

  rotateBy(dYaw: number, dPitch: number) {
    this.chaseTouched = true;
    this.yaw += dYaw;
    this.pitch = MathUtils.clamp(this.pitch + dPitch, -1.55, 1.55);
  }

  /** Advances the camera by `dt` seconds; returns the camera offset from the focus in ecliptic coordinates. */
  update(dt: number, width: number, height: number): Vec {
    const f = this.flight;
    const target = this.positionOf(this.focusId) ?? this.focusPos;
    if (f) {
      f.t += dt / f.duration;
      const t = Math.min(1, f.t);
      const turn = easeInOut(Math.min(1, t / TURN_END));
      const move = easeInOut(MathUtils.clamp((t - MOVE_START) / (1 - MOVE_START), 0, 1));
      const a = f.from();
      const eye0: Vec = [a[0] + f.offset[0], a[1] + f.offset[1], a[2] + f.offset[2]];
      const toEye = sub(target, eye0);
      const l1 = Math.max(len(toEye), 1e-12);
      const dir1: Vec = [toEye[0] / l1, toEye[1] / l1, toEye[2] / l1];
      // the eye slides along the line to the target, from where it started to d1 short of it
      const dist = Math.exp(Math.log(l1) + (Math.log(f.d1) - Math.log(l1)) * move);
      if (turn < 1) {
        const eye: Vec = [target[0] - dir1[0] * dist, target[1] - dir1[1] * dist, target[2] - dir1[2] * dist];
        const dir = slerp(f.dir0, dir1, turn);
        const look = Math.exp(Math.log(f.l0) + (Math.log(dist) - Math.log(f.l0)) * turn);
        for (let c = 0; c < 3; c++) {
          this.focusPos[c] = eye[c] + dir[c] * look;
        }
        this.distance = look;
        this.lookAlong(dir);
      } else {
        if (f.t - dt / f.duration < TURN_END) {
          this.lookAlong(dir1);
        }
        for (let c = 0; c < 3; c++) {
          this.focusPos[c] = target[c];
        }
        this.distance = dist;
      }
      if (f.t >= 1) {
        this.flight = null;
        this.distance = f.d1;
        f.done?.();
      }
    } else {
      this.focusPos[0] = target[0];
      this.focusPos[1] = target[1];
      this.focusPos[2] = target[2];
      const min = this.minDistanceOf(this.focusId) * 1.05;
      this.targetDistance = Math.max(this.targetDistance, min);
      // ease the zoom in log space so each wheel notch feels the same at every scale
      const k = 1 - Math.exp(-dt * 10);
      this.distance = Math.exp(
        Math.log(this.distance) + (Math.log(this.targetDistance) - Math.log(this.distance)) * k,
      );
    }

    if (this.chase && !f) {
      this.followChase(dt);
    }
    this.yaw += this.yawVel * dt;
    this.pitch = MathUtils.clamp(this.pitch + this.pitchVel * dt, -1.55, 1.55);
    const damp = Math.exp(-dt * 6);
    this.yawVel *= damp;
    this.pitchVel *= damp;

    const cam = this.camera;
    cam.aspect = width / height;
    // close to a surface the near plane has to come in with the camera
    const min = this.minDistanceOf(this.focusId);
    cam.near = Math.max(1e-12, Math.min(this.distance * 1e-3, (this.distance - min / 1.05) * 0.2));
    cam.far = 1e9;
    cam.updateProjectionMatrix();

    // scene axes are ecliptic x, z, -y (y up = ecliptic north)
    const cp = Math.cos(this.pitch);
    const sx = this.distance * cp * Math.sin(this.yaw);
    const sy = this.distance * Math.sin(this.pitch);
    const sz = this.distance * cp * Math.cos(this.yaw);
    cam.position.set(sx, sy, sz);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    return [sx, -sz, sy];
  }

  /**
   * Eases round behind the focus, then turns with it as its heading changes, gently and with some lag so
   * fast playback doesn't spin the view. Whatever angle the user drags to is kept relative to the heading.
   */
  private followChase(dt: number) {
    const v = this.velocityOf(this.focusId);
    const speed = v ? len(v) : 0;
    if (!v || speed === 0) {
      this.chaseBase = null;
      return;
    }
    const yaw = Math.atan2(-v[0], v[1]);
    const pitch = MathUtils.clamp(Math.asin(MathUtils.clamp(-v[2] / speed, -1, 1)) + CHASE_LIFT, -1.55, 1.55);
    const raw = this.chaseRaw;
    this.chaseRaw = [yaw, pitch];
    if (raw && dt > 0) {
      const rate = Math.hypot(wrap(yaw - raw[0]), pitch - raw[1]) / dt;
      this.chaseRate += (rate - this.chaseRate) * (1 - Math.exp(-dt * 3));
    }
    const base = this.chaseBase;
    if (base) {
      const follow = 1 - MathUtils.smoothstep(this.chaseRate, CHASE_FREEZE[0], CHASE_FREEZE[1]);
      const k = (1 - Math.exp(-dt * 3)) * follow;
      const cap = CHASE_MAX_TURN * dt;
      const dy = MathUtils.clamp(wrap(yaw - base[0]) * k, -cap, cap);
      const dp = MathUtils.clamp((pitch - base[1]) * k, -cap, cap);
      this.yaw += dy;
      this.pitch = MathUtils.clamp(this.pitch + dp, -1.55, 1.55);
      this.chaseBase = [base[0] + dy, base[1] + dp];
      return;
    }
    if (!this.chaseTouched) {
      const k = 1 - Math.exp(-dt * 4);
      const dy = wrap(yaw - this.yaw);
      const dp = pitch - this.pitch;
      this.yaw += dy * k;
      this.pitch += dp * k;
      if (Math.abs(dy) > 0.002 || Math.abs(dp) > 0.002) {
        return;
      }
    }
    this.chaseBase = [yaw, pitch];
  }

  /** Pixels covered by one AU at `dist` AU from the camera. */
  pxPerAu(dist: number, height: number) {
    return height / (2 * Math.tan(MathUtils.degToRad(this.camera.fov / 2)) * dist);
  }

  private bindInput() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
        this.moved = false;
        this.yawVel = this.pitchVel = 0;
        this.chaseTouched = true;
      } else {
        this.pinch = this.pinchDistance();
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) {
        return;
      }
      const dx = e.clientX - p.x;
      const last = this.lastMove;
      this.lastMove = e.timeStamp;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 4) {
        this.moved = true;
      }
      if (this.pointers.size >= 2) {
        const d = this.pinchDistance();
        if (this.pinch > 0 && d > 0) {
          this.zoomBy(this.pinch / d);
        }
        this.pinch = d;
        this.onUserMove();
        return;
      }
      if (this.moved) {
        this.rotateBy(-dx * ROTATE_PER_PX, dy * ROTATE_PER_PX);
        // carry the last movement as momentum after release
        const dt = MathUtils.clamp((e.timeStamp - last) / 1000, 1 / 240, 0.1);
        this.yawVel = (-dx * ROTATE_PER_PX) / dt / 4;
        this.pitchVel = (dy * ROTATE_PER_PX) / dt / 4;
        this.onUserMove();
      }
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) {
        return;
      }
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0 && this.downAt && !this.moved) {
        this.yawVel = this.pitchVel = 0;
        this.onClick(e.clientX, e.clientY);
      }
      if (this.pointers.size === 0) {
        this.downAt = null;
      }
      this.pinch = 0;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('dblclick', (e) => this.onDoubleClick(e.clientX, e.clientY));
    this.zoomOnWheel(el);
  }

  /** Zooms on wheel and trackpad scroll over `el`; also used for things laid over the canvas, like labels. */
  zoomOnWheel(el: HTMLElement) {
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // trackpads send pixels, mice send lines
        const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.zoomBy(Math.exp(MathUtils.clamp(delta, -300, 300) * ZOOM_PER_WHEEL));
        this.onUserMove();
      },
      { passive: false },
    );
  }

  private pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
