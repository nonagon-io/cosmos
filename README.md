# Solar System

The Solar System in 3D, from 1900 to 2100, with planets, moons, comets and spacecraft where they really were or will be on each date. You can zoom from the Earth and Moon out past the Oort cloud to the nearest stars. The app is Thai first, with an English version.

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

Comet tails are a model too. Their directions follow the physics: the ion tail points straight away from the Sun and the dust tail curves back along the orbit. Their lengths come from `tail` in `bodies.yaml`, roughly what each comet showed near perihelion, scaled by the inverse square of the distance to the Sun, and they fade out beyond `onset` AU (4 by default). The cards say so.

Every body gets a marker dot a few pixels wide so you can find it from far away. The "True size" layer turns that off: spheres are drawn only at their real size, and anything smaller than a pixel becomes a single faint point. The Sun's glare shrinks the same way, and the small-body and Oort cloud dots fade to a faint trace. Normally those dots are hundreds of thousands of times bigger than the objects, which is why the belts look so crowded; the region cards explain this.

Stars to magnitude 6.8 come from the [HYG database](https://github.com/astronexus/HYG-Database) (CC BY-SA 4.0). Those within 17 light years are also placed at their real distance, so they appear around the Sun when you zoom far enough out.

## Textures

Planet maps are from [Solar System Scope](https://www.solarsystemscope.com/textures/) (CC BY 4.0). Pluto uses New Horizons' color mosaic (NASA/JHUAPL/SwRI, public domain). Most of its southern hemisphere was in seasonal darkness during the 2015 flyby and was never photographed; that part is painted a plain color (`unmapped` in `bodies.yaml`) and the card says so. No real maps exist for Ceres at this resolution or for Eris, Haumea and Makemake at all, so those use Solar System Scope's artist's impressions, set with `illustrated: true` in `bodies.yaml`, and their cards say the surface is simulated.

## Editing the data

All data lives in `data/` as YAML and is checked against `src/data/schema.ts` on load and by `npm run validate`.

- `bodies.yaml`: every named body. `orbit` says where its position comes from (`engine`, `jupiter`, `moon`, `named`, `craft`); a new `moon`, `named` or `craft` body also needs an entry in `scripts/fetch-data.ts` and a fetch.
- `regions.yaml`: belts, the heliosphere and the Oort cloud.
- `views.yaml`: the zoom stops in the scale panel.
- `events.yaml`: timeline events. `importance: 3` stops playback when that box is ticked, 2 shows a toast. `uncertain` adds a note for dates that are estimates.
- `timeline.yaml`: the date range, the slider's stretch and the starting camera.
- `i18n/en/`: English text keyed by id. Names come from the `en` field. UI text is in `src/i18n/th.ts` and `en.ts`.
