import { CanvasTexture, Color, SRGBColorSpace, type Texture, TextureLoader } from 'three';

const BASE = import.meta.env.BASE_URL;
const loader = new TextureLoader();
const cache = new Map<string, Texture>();

export interface MapFix {
  /** longitude at the middle of the image */
  center?: number;
  /** color for the black, never-photographed parts */
  unmapped?: string;
}

export function texture(name: string, fix?: MapFix) {
  let t = cache.get(name);
  if (!t) {
    const ext = name.endsWith('alpha') ? 'png' : 'jpg';
    const url = `${BASE}textures/${name}.${ext}`;
    if (fix?.center || fix?.unmapped) {
      t = fixedMap(url, fix);
    } else {
      t = loader.load(url);
    }
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    cache.set(name, t);
  }
  return t;
}

/** Loads a map onto a canvas, turned so longitude 0 sits in the middle like the other maps, with gaps filled. */
function fixedMap(url: string, fix: MapFix) {
  const c = document.createElement('canvas');
  const tex = new CanvasTexture(c);
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const shift = Math.round((((((fix.center ?? 0) / 360) % 1) + 1) % 1) * w);
    g.drawImage(img, shift, 0);
    g.drawImage(img, shift - w, 0);
    if (fix.unmapped) {
      const [fr, fg, fb] = new Color(fix.unmapped).toArray().map((v) => v * 255);
      const data = g.getImageData(0, 0, w, h);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        // jpeg leaves a ragged dark fringe at the edge, so blend over a band instead of a hard cut
        const lum = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
        const k = Math.min(1, Math.max(0, (lum - 8) / 32));
        px[i] = px[i] * k + fr * (1 - k);
        px[i + 1] = px[i + 1] * k + fg * (1 - k);
        px[i + 2] = px[i + 2] * k + fb * (1 - k);
      }
      g.putImageData(data, 0, 0);
    }
    tex.needsUpdate = true;
  };
  img.src = url;
  return tex;
}

let dotTexture: Texture | null = null;

/** A soft round dot for markers and stars. */
export function dot() {
  if (!dotTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.25)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    dotTexture = new CanvasTexture(c);
  }
  return dotTexture;
}

let comaTexture: Texture | null = null;

/** A comet's coma: a bright, small inner core in a wide, faint, slightly green haze. */
export function coma() {
  if (!comaTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(240,255,250,1)');
    grad.addColorStop(0.1, 'rgba(215,250,238,0.8)');
    grad.addColorStop(0.3, 'rgba(175,238,218,0.35)');
    grad.addColorStop(0.6, 'rgba(150,222,205,0.1)');
    grad.addColorStop(1, 'rgba(150,220,205,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    comaTexture = new CanvasTexture(c);
    comaTexture.colorSpace = SRGBColorSpace;
  }
  return comaTexture;
}

let glowTexture: Texture | null = null;

/** The Sun's glare, bright at the centre and falling off slowly. */
export function glow() {
  if (!glowTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,244,214,1)');
    grad.addColorStop(0.08, 'rgba(255,226,160,0.85)');
    grad.addColorStop(0.25, 'rgba(255,190,100,0.28)');
    grad.addColorStop(0.55, 'rgba(255,160,70,0.07)');
    grad.addColorStop(1, 'rgba(255,140,50,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    glowTexture = new CanvasTexture(c);
    glowTexture.colorSpace = SRGBColorSpace;
  }
  return glowTexture;
}
