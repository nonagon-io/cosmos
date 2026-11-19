// Shared shader pieces. Every custom material includes the log depth chunks, because the scene spans
// from metres to light years and a linear depth buffer can't hold that.

export const LOGDEPTH_VERT_PARS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;

export const LOGDEPTH_VERT = /* glsl */ `
#include <logdepthbuf_vertex>
`;

export const LOGDEPTH_FRAG_PARS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
`;

export const LOGDEPTH_FRAG = /* glsl */ `
#include <logdepthbuf_fragment>
`;

/** Kepler's equation for one orbit given as (a, e, i) and (node, argument of perihelion, M at J2000), degrees. */
export const KEPLER = /* glsl */ `
vec3 keplerPosition(vec3 el1, vec3 el2, float day) {
  float a = el1.x;
  float e = el1.y;
  float inc = radians(el1.z);
  float node = radians(el2.x);
  float w = radians(el2.y);
  float n = 0.01720209895 / pow(a, 1.5);
  float m = mod(radians(el2.z) + n * day, 6.28318530718);
  if (m > 3.14159265359) m -= 6.28318530718;
  float ea = e < 0.8 ? m : 3.14159265359 * sign(m);
  for (int k = 0; k < 12; k++) {
    ea -= (ea - e * sin(ea) - m) / (1.0 - e * cos(ea));
  }
  float px = a * (cos(ea) - e);
  float py = a * sqrt(1.0 - e * e) * sin(ea);
  float cw = cos(w), sw = sin(w), cn = cos(node), sn = sin(node), ci = cos(inc), si = sin(inc);
  float x = px * cw - py * sw;
  float y = px * sw + py * cw;
  return vec3(x * cn - y * ci * sn, x * sn + y * ci * cn, y * si);
}
`;
