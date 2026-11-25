# Changelog

All notable changes to Bolones Autodrive. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); new entries go to **Unreleased** first.
Entries describe what changes for someone using the app, compared with the previous version.

## What the app is

A synthwave "coloring book" scene in three.js: a Bolones drives towards a striped sunset sun on an
endless road. Every model is drawn as a flat-colored solid with a neon wireframe, and a side panel
lets you recolor and tweak everything.

- **Menu (idle):** the scene runs, the camera can be orbited with the mouse, the menu can be hidden
  (**H**) to enjoy or recolor the view; PRESS ⏎ TO START blinks at the bottom, as on an arcade
  machine (TAP TO START on touch screens).
- **Free ride (F, or the last card of the list):** steer the Bolones with **← / →**, no obstacles.
- **Minigames (ENTER):** a list to pick one from (← / → and ENTER, or a click). Each starts with
  a 3-2-1 countdown, then oncoming communist-era traffic (Polakito, Kredens, the Ramses van);
  the best score of each is kept in the browser. A digital speedometer sits in the bottom right
  corner, the Bolones goes 150 km/h at most, and after a crash it can still be steered and driven
  on until its engine stalls. On touch screens the keys are on screen, played sideways.
  - **Dodge:** every car that passes scores a point, and every few points the world speeds up
    (`SPEED` in `src/config.js`); the Bolones starts at 50 km/h. A crash ends the game.
  - **Crash:** denser traffic, the Bolones at 50 km/h from the start, and the crash is the goal: it
    scores what it wrecks (the crush, the parts torn off, the palms and rocks hit), times the other
    cars that end up in the wreck, a few or a dozen and more as luck has it each game.
  - **Overtake:** a two-lane road, the slow cars going your way in the right lane, the traffic
    towards you in the left one in groups; ↑ gas, ↓ brake (50–150 km/h on the speedometer), and
    a point for every car overtaken.
- **Scene:** road and scrolling terrain grid that rises into endless procedural mountains on both
  sides and a range in front of the sun, palms and rocks appearing out of the haze, a sky that
  glows crimson at the horizon, soft sunset shadows, glowing
  wireframes, a CRT overlay and an intentionally half-resolution, slightly blurry 80s look.
- **Side panel:** per layer (Bolones, traffic, road, terrain, palms, rocks, horizon range, side
  mountains, city) the fill and line colors and visibility, line fading and glow, palm and rock
  density; sun colors and stripes, mountain height / roughness / start / seed, the city's layout
  and haze, the night sky, sky and fog, bloom, CRT, line width, and "Randomize all".
- **Keys:** ENTER the minigames (← / → choose, ENTER play), F free ride, ESC menu, ← / → steer, ↑
  (or W) faster in the minigame, ↓ (or S) slower in Overtake, TAB from car to car of a wreck, H hide
  menu (or game over), G glow on/off, R randomize all colors, F10 developer stats.

## [Unreleased]

### Added

- The minigames on phones and tablets, with the keys on screen as in mobile driving games: ← / →
  held on the left, the gas pedal (and in Overtake the brake) on the right, the way back in the
  corner and the speedometer between them; after a crash they stay while the wreck can be driven
  on. A minigame goes full screen and sideways where the browser allows it (not on iPhones); held
  upright, it waits, asking to turn the phone; TAP TO START says so. Game over says to pinch, not
  scroll, to pull back, fits a phone held sideways (smaller, with room for the wreck), and every
  button on a touch screen is big enough for a finger.
- `?stats` at the end of the app's address shows the developer stats (FPS, draw calls, triangles)
  from the start: on a phone, which has no F10, compact, at the left edge clear of the thumbs.

### Changed

- The menu waits for a player as a 90s arcade machine does: a blinking PRESS ⏎ TO START (TAP TO
  START on touch screens) in place of the MINI GAME and FREE RIDE buttons and the steering hint.
  ENTER lists what to play, free ride the fourth card beside the three minigames (on a phone held
  sideways the cards show their names alone, side by side).
- The traffic's lines are pale lavender (they were cyan, the colour of the ground and the rocks it
  drives past) and glow less (0.6); its headlamps are warm halogen yellow, apart from them.
- Game over shows the car in view (Tab, or its two arrows, for the next) in the top right corner
  and how to look around at the very bottom; hidden (H, or the eye) it keeps both, to watch the
  wreck. ESC first brings back what H hid, then leaves.
- The SkorczanFFF link in the menu leads to the author's GitHub profile, not to the repository.
- The browser tab's icon is the "B" of the logo.
- A link to the app shows a preview in messengers and on social sites: the title, a line about it
  and a picture of the title screen.
- Hidden, the menu and game over leave a clearer eye in the corner to bring them back; on a touch
  screen a double tap on the scene hides or shows them too.
- Turned round a wreck, the camera no longer goes under the road: it stays above the car in view.
- The score no longer grows and shrinks: a new number lights up a moment, and game over's score
  blinks like a neon sign, as an 80s arcade would.
- Tyres grip sideways as on dry asphalt (from 0.8 to 1 g): a car sliding sideways stops sooner.
- The Bolones' rear lamps: the lower row is one long lamp, without the division the upper row
  keeps.
- Smoother, above all after a crash and on phones: every line is drawn in one go, not twice over
  (its back faces, then its front ones, its material set up afresh each time). A desktop
  draws a frame in about a third of the time (after a crash in 5 ms instead of 14).
- Crashes stutter less: a car crumples about a quarter faster, its dent no longer copies all of
  its points every frame, and a device too slow to keep up plays the crash in slower motion
  rather than in ever longer frames (at most 1/30 s of it a frame).
- Only the cars cast shadows, and only their bodies (the wheels', bumpers' and lamps' fell in the
  body's anyway): the palms' and rocks' were faint on the dark ground, and everything casting one
  was drawn five times more a frame. After a crash a frame takes about half the draw calls.
- The Bolones' fuel cap is an octagon, low-poly like the rest, and casts no shadow.
- The glow no longer draws the whole scene a second time: it draws only the glowing lines,
  hidden behind the solids by the depth of the scene drawn once (a quarter fewer draw calls).
- The palms and the rocks are drawn as copies of their models, all of a model at once: a few
  draw calls for all of them instead of three each (the menu went from 243 draw calls to 80).
- The traffic farther ahead than 50 units is drawn as one mesh a car (its lamps another): four
  draw calls instead of about 25, the same picture (only its wheels, a few pixels there, stand
  still). Close up and in a crash every car is whole, its parts on its rig.

### Fixed

- Fast head-on crashes (from about 170 km/h closing) no longer throw the lighter car aside: the
  crush went deeper than the fronts are wide, and the cars slid through each other and apart. Now
  they stay in each other.
- Corners hit no longer spin the cars round like tops: a corner takes up only its share of the
  crash, by how wide the fronts overlap, and glances off.
- The first look at the city behind the car (the camera turned round a wreck, or in the menu) and
  the first countdown no longer stall: every shader compiles while the game loads.

## [2.5.0] – November 2026

Everything after the 2.0 parity rebuild: three minigames, crashes on Rapier physics, the traffic
traced from blueprints, the cars by their nicknames. Tag `v2.5.0`.

### Added

- New start menu: neon logo in the scene's live colors (the Bolones over the sun, Commodore-style
  stripes of the scene around AUTODRIVE; recolored by the side panel and "Randomize all"), equal
  MINI GAME / FREE RIDE buttons with keycaps, steering hint, best score, and a HIDE button (**H**)
  that leaves only a faint eye icon in the corner.
- In-game HUD (best, score and level), animated countdown, game over panel (score, best,
  NEW BEST, AGAIN / FREE RIDE / MENU); best score saved in `localStorage`.
- Self-hosted fonts: VT323 (HUD, terminal, side panel) and Yellowtail (logo, titles); the loader
  switches off like a CRT; `prefers-reduced-motion` turns UI animations and the CRT flicker off.
- F10 developer stats restyled as a SYS.MONITOR terminal panel.
- Car handling like a real lane change: the nose turns towards where the car really goes, the
  body leans out on its own pivot (wheels stay on the road) on the way in and rocks the other way
  when the car straightens out; the front wheels steer (12°) and counter-steer as the nose swings
  back.
- Minigame traffic instead of boxes: low-poly Polakito and Kredens built in code, traced from
  their blueprints (side, front, rear and top views). Lofted bodies with wheel arches and door
  seams, four flat facets across from the bonnet over the roof to the boot lid (as on the
  Bolones), a cabin with a crowned roof, drip rails and the windows set in behind the pillars and
  frames, all fine enough for a crash to bend, bumpers wrapped round the corners, wheels with a
  tyre, a rim set into it and a hubcap; the Polakito (traced from blueprints): its
  fastback, its windscreen wrapping round its corners in front of the A pillars, its rear face
  leaning back up to the engine lid, big plastic bumpers, rectangular headlamps and indicators
  standing out of the front, flared wheel arches, louvres in the engine lid, tail lamps wrapping
  round the rear corners, the engine's air intake, the door handle, fuel cap and rubbing strips,
  and steel wheels with six slots; the Kredens' three boxes (traced from blueprints of the later
  one), slim A pillars, its windscreen and rear window wrapping round into them with rounded
  corners, louvres in the C pillar, rounded side windows, four round headlamps standing out of a
  dark panel across the front with a barred grille between them and indicators at its ends, the
  front leaning forward over the bumper, tail lamps across the rear, chrome strips along the doors
  and the sills, door handles, the fuel flap and a ring of twelve holes round its hubcaps. Outside
  mirrors: the Polakito the driver's only, as its drawings show, the Kredens one each side. A
  mirror brushed is a crash, as the body is; the lanes keep clear of them.
- A van in the minigame traffic, the Ramses, traced from blueprints (side, front, rear and top
  views) without the gear on its roof: a box with rounded corners, a line running round it
  at the belt and at each of the six ribs pressed into its lower half, flared trapezoid wheel
  arches, walls leaning in up to the gutter and a roof rounding off from it all round to a crowned
  top. Round headlamps in square housings either side of a barred grille, fog lamps and sidelights
  under them, a ledge and a panel up to the windscreen, corner windows wrapping round from its
  sides to the pillars; the front door's and the crew's windows set in, blind panels and louvres
  behind them, a tailgate with its window, tail lamps as cut cones stacked at the rear corners,
  mudflaps, the chassis under the body, and tall lorry mirrors on two arms from each front door. It
  is the widest car, so the lanes keep a little further out.
- The traffic's neon cyan contour lines on night-blue bodies, the complement of the Bolones' pink,
  drawn alike on both sides of each car. Each car, the Bolones too, sits on the same rig: its
  wheels and bumpers are parts of their own, the wheels roll as the cars drive.
- Hold **↑** (or **W**) in the minigame to go half as fast again: it speeds up and slows back down
  gently, but you can see it; a crash at that speed hits harder.
- After a crash the camera follows the Bolones, wherever the crash throws it; **Tab** (or the
  button under the score, which names the car and its number, e.g. "Polakito 2/3") takes it to
  each car of the wreck in turn, in the order they crashed. Elsewhere Tab still moves the focus
  between buttons. **H** (or the eye in the corner) hides game over too, to see the wreck alone.
- Visuals:
  - the sun as a wide soft light source (five shadow-casting lights spread over the disc);
  - toon shading (three flat bands) and the Retrowave Dusk palette (dark fills, neon lines);
  - procedural, anti-aliased terrain grid and synthwave sun shaders;
  - sky gradient with a glowing horizon; road and terrain reach the horizon inside the fog;
  - palms, rocks and traffic fade in and out (eased) instead of popping up and vanishing;
  - wireframes drawn by a shader: line width in world units, lines of tiny on-screen triangles
    fade out (per layer), so far palms no longer turn into solid blobs;
  - bloom on the wireframes and the terrain grid, glow strength per layer, **G** to switch it;
  - optional ink-outline mode (`WIRE.mode: "edges"`).
- Procedural synthwave mountains instead of the 2020 hill models: ridged noise on the ground
  grid, low-poly triangles split along the ridges. Both sides of the road roll endlessly towards
  the camera and grow out of the ground as they come closer (flat strips for palms and rocks
  stay). A static range in front of the sun rises layer behind layer and is parted like a sea for
  the road, the striped sun showing in the pass. A new landscape on every visit; a Mountains
  folder in the side panel sets height, roughness, where they start and the seed, plus a
  "New landscape" button.
- Side panel: Glow switch, Bloom folder, line width, per-layer line fade / line min / glow,
  traffic layer, aligned columns with square color previews and `#hex` values.
- Phones and tablets: the scene fits portrait screens (a wider view, and the camera follows the
  car sideways), the HUD keeps clear of notches and the home indicator, and free ride has
  on-screen steering (hold ← / →) and a MENU button. The minigame is not offered on touch screens
  yet.
- **R** randomizes all the scene colors, like the side panel's "Randomize all" button, in the
  menu and mid-game alike (the button says "Randomize all (R)").
- A GITHUB link to the source code in the menu's bottom right corner (under the buttons on
  phones); it hides with the menu (**H**).
- Vercel Web Analytics (cookieless page views) on the Vercel deployment; the GitHub Pages one
  sends nothing.

### Changed

- The Bolones with its wheels, the rocks and the palms show their lines as quads, the way they
  were modelled (read from the FBX files: edge visibility, quads), instead of every triangle.
  Lines fade by the size of the whole polygon, so long thin panels no longer lose their outline
  early, and keep their full width, without notches up close or ticks from afar, where a quad's
  hidden diagonal or a hidden line leaves a thin corner.
- The Bolones reads like an 80s vector drawing: its models keep only the contour lines (open edges,
  material borders and creases of 20° or more, each line as a whole, without soft ends), so the
  outline, shoulder and belt lines, window frames, arches, lamps and the rear louvre stand out, and
  the wheels show their three spokes instead of a spider web. By hand: the front indicators and the
  rear lamps keep their divisions, both bumpers the short seam to the side as on the real car, and
  the front door its outline (its front edge from the sill up, along the sill, and up the B
  pillar's end, the sides cut there for it), as on the traffic; the dividers under the front
  indicators and rear lamps are gone, as is the line along the lower edge of the side strip, the
  bumpers' sides and the front bumper's face, and the crease from the A-pillar along the roof that
  ended halfway down the tailgate (with the ends of the roof seam it left behind); the exhaust
  pipes keep three of their lengthwise lines. The wheels: tyre, rim and hub as double rings and the
  spokes as outlines, without the rungs of the rim and hub barrels or the back of the disc showing
  through the openings.
  The Bolones lines glow stronger (0.6). The palms follow suit with lengthwise lines only: smooth
  trunks without their segment rings, every leaf alike, its edges and midrib from the crown to the
  tip.
- Side panel: the color swatches open the app's own color picker instead of the browser's (a
  different system dialog on every OS): a saturation / brightness square, a hue strip, the hex
  code, the palette's colors, and the old color beside the new one (tap it to bring it back);
  the scene follows every change. With a mouse it opens beside the panel (ENTER or a click
  elsewhere keeps the color, ESC brings the old one back, arrows fine-tune it); on touch and small
  screens it is a compact bottom sheet with OK and CANCEL.
- The scene shows a grab cursor only where it can be orbited (menu, free ride) and a grabbing one
  while the left button holds it; the minigame keeps the plain cursor.
- Free ride: the camera rides along with the Bolones (you can still orbit around it) and comes
  back with it on ESC; the minigame and the menu keep their fixed camera.
- Free ride: the Bolones brakes into the road edge instead of stopping dead (which jolted the
  whole view, worst on phones), stops before turning back, and no longer shows steering while it
  pushes against the edge. The minigame keeps its handling.
- The Bolones sits 4 cm higher (`CAR.lift`), so its tyres no longer look sunk into the road.
- The UI tints that follow the scene colors (panels, buttons, titles after "Randomize all") are
  now mixed by the stylesheet in oklch: the same hue turn, lightness and chroma kept perceptually.
- Performance: the city is drawn in bands, so it costs nothing while it is behind the camera (it
  used to be drawn every frame: about a quarter of the frame's triangles).
- Side panel: sky and fog in an Environment folder, line width in the Bolones folder, CRT Effect
  starts closed.
- The game over panel stays until you pick AGAIN, FREE RIDE or MENU (it used to return to the
  menu after 3 s). The score is its headline, a big centered number with the record (or
  NEW BEST!) under it, and the panel is frosted, so the scene behind it no longer competes.
- Side panel: color fields take a typed or pasted `#hex`; a roomier "Randomize all" button.
- Crimson fog (`#c70050`) instead of magenta.
- The world is twice as long: palms and rocks come from 200 m ahead (the road starts lined with
  them), the fog reaches 400 m and the sun is twice as far and twice as big (same size on screen).
- Game over counts the score up arcade style once its panel is in, then flashes it and keeps it
  pulsing like a neon sign; the tail of the big "G" in "Game Over" is no longer cut off.
- Game over keeps the wreck in view: the "Game Over" title slams in over the sky (crash mode, where
  the crash is the goal, has none), the score alone under it, what made it in a line below (the
  level, or the cars in the wreck and what it wrecked) and the record to beat under that; the
  buttons line up along the bottom, instead of a blue panel over the middle of the screen. From
  the crash on, drag to look around it and scroll to pull back.
- A crash no longer cuts straight to the menu: the moment of impact freezes, then plays out in
  slow motion by the laws of car crashes (on Rapier physics). The cars meet through their
  crumple zones, as stiff as they are heavy (the Bolones weighs a Kredens and 150 kg, a Polakito
  half as much): momentum is kept and the energy goes into the crush, so they stop where they met
  instead of bouncing off, the lighter car takes the deeper dent, and the faster the game goes
  (every 20 points), the deeper the dents and the more shards and sparks fly. Fast crashes barely
  bounce (the restitution falls off with the speed, as in crash tests); fronts that meet across
  half their width or more lock and the wreck turns as one, a corner each glances off, and sides
  swiped against each other slide on.
  Every car stands on four wheels: springs that hold it where it stood (anti-roll bars across the
  axles), tyres that grip the road one by one, brakes and steering; a car tipped over, or down a
  wheel, scrapes the road with its body and stops instead of sliding on, and one rolled over lands
  on its roof. None of it stalls the game: a dent measures the lines it had afresh instead of
  working them out again, and a crash is played once, unseen, while the game loads.
  The sheet metal bends, not just dents: crushed flat where the cars met, buckling in folds, it
  folds up into a ridge behind (the bonnet, as wide as it was hit, the boot lid; the roof, the
  wings and the pillars hold) and bulges out at the sides, an offset hit bends the car towards the
  side hit, and a front driven into a side leaves a V, not a cut, only as wide as they meet (a
  corner going in at an angle, not the whole side flattened), the doors buckling sideways
  while the car slides away (cars are heavy low down: a hit pushes them more than it tips them); a
  small car folds smaller. The wheels are not squashed but pushed back, turned and leaning, and
  the car pulls where they point; a wheel or a bumper crushed well past comes off, flies on, rolls
  to a stop and bounces off the cars, the palms and the other parts, and a car down a wheel sinks
  onto that corner's hub. A crushed headlamp goes out (the body's colour, outlined); the other
  keeps shining until a pile-up gets it.
  Every driver, the Bolones' too, rolls on for a moment until they react, then brakes as hard as it
  takes to stop a few metres short of the car ahead, should that one brake hard, and at least
  gently: far off they have seen the crash and brake calmly, straight on; only who cannot stop in
  time panics, braking hard, half of them swerving about a lane over. A car hit on its side pulls a
  few degrees that way for good, a wheel there broken. The traffic keeps coming out of the haze for
  a while after the crash, where it can still stop for the jam, its drivers (who saw it coming)
  braking at once, and on while the camera goes on along the road; the cars of the wreck, and the
  palms and rocks round it, stay in view wherever they end up, past the end of the road too.
  Whoever cannot stop in time runs into the wreck: a
  car hit again is crushed on top of its earlier dents, and crushed ends meet instead of passing
  into each other; even a car that only touched another is crushed when it is pushed into it. The
  palms and the rocks take part too, every one by the road: a car thrown off the road stops at a
  trunk itself (round, as thick as it is where a car hits it), wrapped round it, the palm leaning
  and swaying, or at a rock, however low (a rock does not break: no shards of it).
  Nothing goes on into the side hills: they stop it where they rise.
  The shards stay on the road until the next game. The camera shakes, the screen flashes; the
  score and the buttons show up 2.5 s later, once the wreck has about settled and keys and buttons
  work again (no accidental restart). The camera and the side panel come back only when you leave
  game over, the camera where it always is in the game, and the Bolones blinks back to the start.
- MINI GAME (ENTER) lists the minigames, DODGE, CRASH and OVERTAKE, each with its best score: ← / →
  choose (the last one played comes up lit), ENTER or a click plays it, ESC goes back; AGAIN in game
  over plays the same one again. Both records show under the logo too; a record beaten shows NEW
  BEST! as the count passes it.
- Crash, a new minigame: the same road with half as much traffic again, and the crash is the goal.
  On the way the scoreboard shows how fast the traffic comes at the Bolones (IMPACT, km/h), the
  Bolones at 50 km/h from the start, faster every 10 cars passed, and the faster, the harder the
  crash. The crash scores what it wrecks, live: a point per kJ the crumple zones take up, 20 per
  wheel or bumper torn off and per palm or rock hit, all of it times the other cars that end up in
  the wreck; its drivers are a little slower to react, so a few more pile in, and how big the
  pile-up gets is rolled each game: that share of the traffic coming along after the crash does not
  see the wreck in time and runs into it, and it keeps coming longer. After the crash the Bolones is
  still yours, a little, in every minigame: ← / → turn its front wheels, ↑ drives the wreck on (by
  the rear wheels that are left), let go it brakes gently, until the engine sputters out 6 s after
  the crash, the jam behind the wreck there to drive into. Game over shows what made the score and
  counts on as more cars pile in.
- Overtake, a new minigame: a two-lane road, the cars going your way in the right lane (turned
  round, at 40 km/h, close behind one another, some already ahead at the start), the traffic
  towards you in the left one at 60 km/h, in groups of one to four with room to overtake
  between them. You set your own speed, 50 to 150 km/h on the speedometer: ↑ (or W) gas, ↓ (or
  S) brake, let go it holds; at the slowest you go as fast as the cars ahead, so you can wait
  behind one for a gap. A point for every car overtaken; every 20 the traffic towards you comes
  faster. A crash here comes without warning: the drivers are slow to see it and slow to stop,
  so the cars overtaken run into the wreck or try to swerve round it.
- The Bolones has its fuel cap: a round lid on the right rear wing above the wheel, as the
  real car had it.
- The traffic's wheels show their rims set in, the lip round them no longer see-through; the
  headlamps cast no shadow of their own (five fewer shadow draws each).
- Menu, game over and the loading screen fit phone screens: the buttons stack, the loader's
  terminal and text shrink to the width, and the logo shrinks smoothly with narrow screens
  ("Bolones" never under ~310 px) instead of jumping between sizes.
- Touch screens (phones, tablets without a keyboard) get the scene to look at: a bigger logo,
  HIDE, the side panel (starting folded) and the camera orbiting with one finger, pinch to zoom.
  Pinching the scene zooms the scene, never the page.
- Side panel: the hill layers are now "Horizon range" and "Side mountains"; "Line width (all)"
  says that it sets every line.
- "Randomize all" picks a palette instead of unrelated random colors: a few related hues, and
  lines in another hue than their model that always stand out from it (at least 3:1 contrast),
  so they no longer vanish into a fill of a similar color. Three moods: night (dark fills, neon
  lines, dark sky, glowing fog), day (pastel fills, dark lines, light sky) and mixed, where every
  layer goes dark or light on its own.
- The interface wears the scene's palette: panels, buttons, the loader, the HUD and the side
  panel take their hue from the ground grid, the Bolones lines and the sun, keeping their
  brightness, so a recolored or randomized scene no longer sits under a blue UI and every text
  stays as readable as with the default colors.
- No flash of unstyled buttons on a white page before the app loads: the page stays dark and
  empty until its styles and colors are in, then the loader appears.
- Behind the car: night falls over the back of the sky, with stars and a crescent moon striped
  like the sun, blending softly into the sunset (only under a dark sky: a light, daytime sky stays
  without stars). Far away stands the neon metropolis we drive away from, far wider than the
  valley: a ragged skyline bending away like a banana, its tall, dense downtown nearest, the lower
  outskirts further back, its towers rising over the side mountains out of a haze in the fog
  color, outlined in neon with lit windows (whole floors, columns or single ones, different per
  tower). A Night sky folder sets the night color, how far round the sky it reaches and how soft
  the dusk is, the stars and the moon; the City layer sets the number of towers, their height,
  lit windows and the haze. "New landscape" moves the city too.
- Behind the car the side mountains sink back into the ground before they leave, opening onto
  the city, instead of vanishing in big chunks in front of it.
- The horizon range no longer starts with an even, flat ramp: its foot is ragged, the rock
  beginning further back in some places than in others, rising in steep faces, with loose crags
  in front.
- Side panel in thematic order: the cars and the sun, the road and its sides, the landscape
  (mountains, horizon range, side mountains, city), the night sky and the environment (with the
  landscape seed and "New landscape"), the effects, then the switches; the glow switch is now
  "Wireframe glow (G)".
- Shadows are drawn only for things near the car, not for the palms and rocks far behind it
  (about 18% fewer triangles and 29% fewer draw calls per frame).
- With the wireframe glow on, the five suns' shadows are drawn once a frame, not again for the
  glow (which has no shadows): half the draw calls of a crash full of cars.

### Removed

- `gridline2.png` and `suneffectalt.png` (820 KB), replaced by shaders.
- `hills.fbx` and `side.fbx` (161 KB), replaced by the procedural mountains; with them the
  side hills clipping through the horizon hills.

### Fixed

- With "reduce motion" on in the OS, the CRT flicker is off by default but can be switched on in the
  side panel again; the stylesheet no longer overrides the switch.
- The sun's "Show effect" switch in the side panel works again: since the rebuild it had not been
  toggling the gradient, the cuts and the halo.

## [2.0.0] – October 2026

Rebuilt from scratch on Vite and three.js r186 (from r116), with the same look and gameplay.
Tag `v2.0-parity`.

### Changed

- Vite build, JSDoc type checking, Vitest unit tests, Prettier; GitHub Pages workflow and a
  pinned Vercel config.
- One source of truth (`src/config.js`): palette, layers, world size, gameplay, keys and texts.
- One main loop for everything that moves or waits; a pure state machine for idle / free ride /
  countdown / playing / game over; modular world parts.
- Real loading progress; every asset is loaded once.
- Data-driven side panel (lil-gui) with smooth "Randomize all".
- ESC also works during the countdown; after game over the app returns to the menu.

### Added

- Free ride mode (**F**); ENTER always starts the minigame.

### Fixed

- Frame-rate dependent steering; hold-to-accelerate now works.
- Restarting right after game over; ENTER resetting the car mid-game.
- Memory leaks in the minigame and the side panel; a hitbox larger than the visible boxes.

## [1.x] – 2024 to January 2026

The original version (three.js r116, plain JavaScript). Tag `v1-legacy`.

### January 2026

- Codebase cleanup and dead code removal.
- Fixed the wheel and texture animation speed.

### August 2025

- Fixed boxes spawning too far left and right in the minigame.

### June 2025

- Smooth camera move when the minigame starts; smooth Bolones steering.
- Grab cursor on the scene; the Bolones stays still during the countdown and resets after a
  crash or escape.
- Box spawning tweaks; steering disabled during the countdown.
- "Randomize" scene colors in the side panel.

### May 2025

- Fixed the Bolones model; the wheels are separate from the body.
- Steering (left / right) after pressing ENTER.
- Retro loading screen; the CRT effect adjustable in the side panel.

### September 2024

- Palm trees and road elements; updated color palette.
- Deployed to Vercel.
