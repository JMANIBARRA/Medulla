# Vehicle models for the Garage

Files in this folder are shown on the Garage pedestal. Matching happens in `VEHICLE_MODELS`
(search for it in `index.html`); a vehicle can also point at its own file from
**Customize ▸ 3D model or render**.

| Type | Extensions | How it's shown |
| --- | --- | --- |
| 3D model | `.glb` (preferred), `.gltf` | Studio-lit WebGL viewer, slow turntable spin, drag to rotate |
| Render | `.svg`, `.png`, `.webp` (transparent background) | Static studio render with shadow, reflection and light sweep |

You normally don't need any files here: the Garage finds a realistic 3D model of each vehicle
automatically on Sketchfab (year + make + model, see `garFindModel` in `index.html`). Use this
folder only to override that pick with a model of your own. To pick a different Sketchfab model
for one vehicle, paste its Sketchfab link into **Customize ▸ 3D model**.

## Expected files

| File | Used for |
| --- | --- |
| (none required) | Vehicles are matched automatically |

## Adding a model

1. Drop the file here, e.g. `models/vehicles/honda-civic-2016.glb`.
2. Add an entry to `VEHICLE_MODELS`:

   ```js
   { id:"honda-civic-2016", name:"Honda Civic", aliases:["civic"], years:[2016, 2021],
     asset:"models/vehicles/honda-civic-2016.glb", orbit:"-35deg 76deg auto",
     credit:{ text:"Model by <author>, CC BY 4.0", url:"<source page>" } },
   ```

   `orbit` is the starting camera angle (azimuth, elevation, distance). `credit` appears under the
   stage; include it whenever the model's license requires attribution (e.g. CC BY).

## Tips

- Keep files small: under ~8 MB loads quickly. Tools like https://gltf.report or
  `npx @gltf-transform/cli optimize in.glb out.glb` shrink models a lot.
- Models should face along the X or Z axis with wheels on the ground plane; the viewer frames
  them automatically.
- Free sources: Sketchfab (filter by "Downloadable" and check the license), Poly Pizza (CC0),
  Kenney's Car Kit (CC0). Only use models whose license allows you to publish them on your site.
