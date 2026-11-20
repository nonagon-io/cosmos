# Solar System

The Solar System in 3D, from 1900 to 2100, with planets, moons, comets and spacecraft where they really were or will be on each date. You can zoom from the Earth and Moon out past the Oort cloud and the nearby stars to the whole Milky Way and the Magellanic Clouds. The app is Thai first, with an English version.

```
npm install
npm run dev               # http://localhost:5173
npm run build             # type check, lint and data check, then build to dist/
npm run validate          # check the data files only
npm run fetch-data        # download everything in public/data and public/textures again
npm run check-ephemeris   # compare positions with JPL Horizons on a few dates
```

`npm run fetch-data -- moons spacecraft` runs only those steps. The steps are smallBodies, named, moons, planets, spacecraft, stars and textures. Everything comes from public APIs and takes a few minutes.

Keys: space plays, `+` and `-` zoom, the arrows turn the camera, `[` and `]` jump to the previous or next event, `f` flies to the selected body, `c` makes it the center without changing the zoom, `v` turns the camera to face where the center body is heading, Esc closes the card, Cmd/Ctrl+F searches.

## Code style

Formatting and lint come from [Biome](https://biomejs.dev/) (`biome.json`): 2 spaces, single quotes, semicolons, trailing commas, 110 columns, plus a few rules on top of the recommended set (block statements, no `forEach`, no `any`, naming). `npm run format` fixes what it can, `npm run lint` only reports. `npm run check` runs it together with `tsc` and the data check, and pull requests run the same in CI. For VS Code, install the Biome extension; `.vscode/settings.json` formats on save.

## Where positions come from

Everything is heliocentric, ecliptic J2000, in AU.

- Earth, Mercury, Venus, Mars and the Moon come from [astronomy-engine](https://github.com/cosinekitty/astronomy) (VSOP87 and its lunar theory), within about 500 km of JPL for Earth. So do the Galilean moons and every spin axis.
- Jupiter to Pluto follow JPL Horizons paths of each system's barycenter, because astronomy-engine's shortened VSOP87 puts Neptune a few hundred thousand km off. Pluto is moved off its barycenter by Charon's pull.
- Other moons use osculating elements from Horizons, sampled about twelve times per orbit and interpolated.
- Named asteroids, comets, dwarf planets and interstellar objects follow Horizons state vectors, sampled more finely around perihelion. Outside the span Horizons covers they fall back to a two-body orbit, and their card says so.
- Spacecraft follow Horizons too, with 10-minute samples around each planet flyby. Those windows are taken relative to the planet, since a spacecraft's trajectory file carries the planet ephemeris of its day (Neptune in 1989 was some 5,000 km off today's). Past the end of JPL's data, which is 2050 for most of them, the fetch script carries each craft on under the Sun's gravity and the card marks it as coasting.
- The asteroid belt, NEOs, Jupiter trojans, centaurs, TNOs and comets are about 61,000 objects from the JPL Small-Body Database, each moved along its own Kepler orbit in the vertex shader. Their elements are fixed at one epoch, so they drift from reality over decades. That doesn't matter as a crowd, but don't read single dots as real positions. The belt cards and the layer's tooltip say this in the app too.

`npm run check-ephemeris` prints the error against Horizons for a set of bodies. In 2026 everything shown is within about 1,200 km, most within a few hundred.

The Oort cloud has never been observed. It is drawn from a model: an inner, flattened Hills cloud from 2,000 to 20,000 AU and a round outer cloud to 100,000 AU, with density falling as r^-3.5. Its card says it is a model. The heliosphere is drawn as two plain shells at the termination shock (94 AU) and heliopause (121 AU), where the Voyagers crossed them.

Comet tails are a model too. Their directions follow the physics: the ion tail points straight away from the Sun and the dust tail curves back along the orbit. Their lengths come from `tail` in `bodies.yaml`, roughly what each comet showed near perihelion, scaled by the inverse square of the distance to the Sun, and they fade out beyond `onset` AU (4 by default). The coma is a soft glow sized from `coma` (km) the same way. The cards say so. 3I/ATLAS's nucleus has never been resolved, so it's drawn as a generic lumpy comet nucleus at the middle of the size estimates (`shape.guess`), and its card says that too.

Every body gets a marker dot a few pixels wide so you can find it from far away. The "True size" layer turns that off: spheres are drawn only at their real size, and anything smaller than a pixel becomes a single faint point. The Sun's glare shrinks the same way, and the small-body and Oort cloud dots fade to a faint trace. Normally those dots are hundreds of thousands of times bigger than the objects, which is why the belts look so crowded; the region cards explain this.

Stars come from the [HYG database](https://github.com/astronexus/HYG-Database) (CC BY-SA 4.0). The 108,000 or so with a parallax distance within 3,000 light years are placed in 3D (`field.bin`), and the shader works out each one's magnitude from wherever the camera is, so from inside the Solar System they make up the night sky and further out they spread into the real neighbourhood. Out there the stars are brightened like a long exposure, or almost none would show. The catalogue is only complete for stars bright enough to measure from Earth, so the field looks thicker around the Sun than it is; the star-field card says so. The few hundred naked-eye stars without a usable distance stay on a sky sphere at infinity and fade out once the camera leaves the Sun. Clusters and nebulae are entries in `regions.yaml` with `at` (RA, Dec, light years); the nebula glows are simple stand-ins.

Nobody has seen the Milky Way from outside. Seen from above, it's Robert Hurt's painting for NASA/JPL-Caltech/ESO (eso1339g, CC BY 4.0), laid in the galactic plane and scaled so the Sun sits the measured R0 from the centre (the gap was measured on the annotated version of the image). Edge on a flat picture vanishes, so as the view tilts it gives way to a model built from points (`src/scene/galaxy.ts`): a bar, an exponential disk and five spiral arms. The parts that are measured are its size, the Sun's distance from the centre (8.18 kpc, GRAVITY 2019) and height above the plane, the tilt of the plane on our sky (the IAU galactic frame), and the arms on our side, which follow the log-spiral fits to maser parallaxes in Reid et al. 2014. The far side, hidden by dust, is the same spirals carried on. The Galaxy's card says all this. Sgr A* and the Magellanic Clouds are placed at their real positions and distances.

Up close, Sgr A* (`src/scene/sgra.ts`) is a simulated accretion disk, ray traced in a shader: each pixel's ray is bent as light bends around a non-spinning black hole, so the far side of the disk shows over and under the shadow. The shadow is the real size (about 5.2 Schwarzschild radii, which matches the 51.8 µas ring the EHT measured), the gas moving toward us is brighter and bluer, and the disk is tilted so that from Earth it looks roughly like the EHT image. The real Sgr A* is fed so little gas that it has no bright thin disk like this; the card says it's a film-style simulation. The gas turns at its real orbital speed with the timeline (about 33 minutes round the inner edge), so it stops when paused; at fast playback it fades into an even glow rather than strobing. Eleven S-stars move on their measured orbits (Gillessen et al. 2017, S2 from GRAVITY 2019, S4711 and S4714 from Peißker et al. 2020), turned from sky-plane elements into the ecliptic frame. All of it lives in a group placed at Sgr A*, so the vertices are a few thousand AU at most; at 1.7 billion AU from the Sun, 32-bit floats couldn't hold the ring otherwise. Flying there looks along our line of sight, so the orbits look like the published plots. Views and fly-tos to the Galaxy end above its plane (`tilt` in `views.yaml`), because edge on the whole disk piles into one bright line.

## Textures

Planet maps are from [Solar System Scope](https://www.solarsystemscope.com/textures/) (CC BY 4.0). Pluto uses New Horizons' color mosaic (NASA/JHUAPL/SwRI, public domain). Most of its southern hemisphere was in seasonal darkness during the 2015 flyby and was never photographed; that part is painted a plain color (`unmapped` in `bodies.yaml`) and the card says so. Charon uses New Horizons' grey global map (PIA19866, public domain) the same way; the side facing away from Pluto was only seen from far off, so it's blurry. No real maps exist for Ceres at this resolution or for Eris, Haumea and Makemake at all, so those use Solar System Scope's artist's impressions, set with `illustrated: true` in `bodies.yaml`, and their cards say the surface is simulated.

## Editing the data

All data lives in `data/` as YAML and is checked against `src/data/schema.ts` on load and by `npm run validate`.

- `bodies.yaml`: every named body. `orbit` says where its position comes from (`engine`, `jupiter`, `moon`, `named`, `craft`); a new `moon`, `named` or `craft` body also needs an entry in `scripts/fetch-data.ts` and a fetch.
- `regions.yaml`: belts, the heliosphere and the Oort cloud, plus star clusters, nebulae and galaxies placed with `at`.
- `views.yaml`: the zoom stops in the scale panel. `tilt` views the Galaxy from that many degrees above its plane, and `also` centres the view halfway between `focus` and a second object.
- `events.yaml`: timeline events. `importance: 3` stops playback when that box is ticked, 2 shows a toast. `uncertain` adds a note for dates that are estimates.
- `timeline.yaml`: the date range, the slider's stretch and the starting camera.
- `i18n/en/`: English text keyed by id. Names come from the `en` field. UI text is in `src/i18n/th.ts` and `en.ts`.
