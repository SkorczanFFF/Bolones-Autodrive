# B O L O N E S – A U T O D R I V E

**Created by:** Maciej Skorus

A synthwave-styled Three.js "coloring book"-like animation with three minigames: dodge the oncoming communist-era traffic, crash into it for the damage, or overtake it. A built-in GUI lets you experiment with the scene's models and colors. See [CHANGELOG.md](CHANGELOG.md) for what the app does and how it got here.

The Bolones, its wheels, the palms and the rocks were modeled in 3Ds Max 2018, updated in 3Ds Max 2023, and exported as `.fbx` files; those files are the source now, their lines edited by script. The minigame traffic (Polakito, Kredens, the Ramses van, traced from blueprints) and the mountains are built in code.

---

## 🔗 Live Demo

- [https://bolones-autodrive.vercel.app/](https://bolones-autodrive.vercel.app/)
- [https://skorczanfff.github.io/Bolones-Autodrive/](https://skorczanfff.github.io/Bolones-Autodrive/)

---

## 🎮 Controls

| Key | Action |
|---|---|
| **ENTER** | PRESS START: what to play, the minigames and free ride (also from free ride): **← / →** choose, **ENTER** play; in game over: the same one again |
| **F** | Free ride at once: steer without obstacles |
| **← / →** | Steer; in every minigame also after the crash, with **↑** to drive the wreck on until its engine stalls |
| **↑ / W** | Hold to speed Dodge and Crash up by half; in Overtake: gas |
| **↓ / S** | In Overtake: brake |
| **TAB** | After a crash: the camera from car to car of the wreck |
| **ESC** | Back to the menu; with the menu or game over hidden (**H**), first brings it back |
| **H** | Hide / show the menu (eye button in the top-left corner) to enjoy or recolor the scene; in game over the car switcher and how to look around stay, to watch the wreck |
| **G** | Glow on the wireframes on / off (also in the side panel) |
| **R** | Randomize all: new colors for the whole scene (also in the side panel) |

All menu and game over buttons are clickable too. Drag with the mouse to orbit the camera outside the minigame and around a wreck, scroll to pull back.

On touch screens (phones, tablets without a keyboard) orbit with one finger, pinch to zoom and recolor the scene in the side panel. Free ride and the minigames have the keys on screen: hold ← / → on the left to steer, and in a minigame ↑ (gas) and, in Overtake, ↓ (brake) on the right, also after a crash while the wreck can be driven on. The minigames are played sideways: full screen and turned where the browser allows it; held upright, a game waits for the phone to turn. A double tap on the scene hides or shows the menu and game over, as **H** does.

---

## 🛠️ Development

Requires Node.js 22.12+.

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve the production build
npm test           # unit tests (Vitest)
npm run typecheck  # JSDoc type check (tsc)
npm run format     # Prettier
```

Press **F10** in the app, or add `?stats` to its address (a phone has no F10), for the developer
stats overlay (FPS, draw calls, triangles, memory).

### Tests

Modules export the pure functions behind a feature (geometry, layouts, color math, formatting)
as their API, and the tests use them; world parts expose their moving pieces (`car.chassis`,
`sideHills.meshes`) for tests and debugging. Tests import the constants they check from `src/`
instead of repeating them, and share fixtures through `tests/helpers.js`.

### Project layout

```
src/
  config.js        single source of truth: palette, layers, world size, gameplay, keys, texts
  main.js          bootstrap
  core/            renderer, wireframe bloom, main loop, tweens, asset loading, input, device
                   detection, seeded noise, random picks
  scene/           materials, shader wireframes, the Bolones (its model, how it moves), minigame
                   traffic (built from traced data: traffic, sedan, van, car parts, decals;
                   outlines, triangulation, polygons), dents, spawner, height fields, mountain
                   shapes, world
    environment/   independent world parts: sky, lights, ground, sun, horizon range (hills),
                   side mountains (side hills), scenery, city
  game/            state machine, game orchestration, its camera, minigames, crash physics (crash/)
  ui/              theme, loader, HUD, scene GUI, CRT overlay, F10 stats
public/            FBX models (Bolones, wheel, palm, rocks) and textures
tests/             Vitest unit tests
```

- Change colors, world dimensions, speeds or texts in `src/config.js` only; CSS gets the palette as custom properties.
- Every world part follows `create(context) -> { update(dt, speedMultiplier) }` and knows nothing of the others; the rest of the app sees only the world (its settings, the roadside props, regenerate), so a part (e.g. the procedural mountains) is replaced in `scene/world.js` alone.
- Everything that moves or waits runs inside the single main loop.

---

## ℹ️ Info

- Resolution is intentionally halved to enhance the 80s aesthetic
- The mountains are procedural: ridged noise on the ground grid, low-poly triangles split along the ridges.
  - Both sides of the road are an endless conveyor of chunks rolling towards the camera; they grow out of the ground as they come closer, rising out of the horizon range.
  - The horizon range in front of the sun is static and parted like a sea for the road, so the striped sun shows in the pass.
  - The side panel (**Mountains**) sets their height, roughness and where they start, and the seed: a new landscape on every visit, or **New landscape**. The line style (triangles or squares) is `MOUNTAINS.lines` in `src/config.js`.
- The road starts lined with palms and rocks; they come from far ahead (`SPAWN` in `src/config.js`) and fade in and out.
- A crash runs on [Rapier](https://rapier.rs) physics (WebAssembly, loaded with the assets): every car on four sprung wheels, crumple zones that dent the meshes, parts torn off, pile-ups. A crash is played once, unseen, while the app loads, so the first real one does not stall.
- A digital speedometer shows in every minigame; the Bolones starts at 50 km/h and goes 150 km/h at most.
- The Vercel deployment counts page views with Vercel Web Analytics (enabled only in Vercel builds, see `vite.config.js`); local and GitHub Pages builds load nothing.

---

## 🐞 Known Bugs

- A car that falls onto another car's roof passes through it: cars meet only through their sides.

---

## 🌟 Future Ideas

- Rocks and palms that follow the terrain, so the mountains can start closer to the road; a sidewalk
- Palette presets: Original 2024, Take On Me, Game Boy, Tron, Vaporwave
- More communist-era cars in the minigame

---

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md).
