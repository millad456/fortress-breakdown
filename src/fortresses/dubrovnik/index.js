import * as THREE from 'three';
import * as content from './content.js';
import * as L from './layout.js';
import { heightAt, isInsideCity } from './terrain.js';
import { buildWorld } from './build.js';
import { createModes } from './modes.js';
import { createSiegeFX } from '../../app/siegefx.js';
import { createAmbient } from '../../app/ambient.js';
import { softSpriteTexture } from '../../app/textures.js';

/** Cinematic intro path (camera points) and look-at points. */
const INTRO = {
  // skim in low over the sea, climb the cliff under the sea walls, cross the roofs to Minčeta, then pull back
  points: [[-330, 9, 930], [-60, 16, 600], [100, 62, 370], [215, 118, 150], [250, 150, -110], [520, 235, -330], [860, 330, 120], [780, 360, 660]],
  lookAt: [[190, 40, 250], [195, 38, 240], [200, 30, 170], [190, 20, 0], [165, 45, -165], [230, 25, -40], [225, 20, 40], [220, 20, 60]],
  fov: [64, 46],          // wide while low and fast, settling to the normal lens
  hours: [6.1, null],     // dawn breaks during the approach (null = the viewer's current hour)
  duration: 11,
};

export default {
  content,
  /**
   * Build the Dubrovnik world into the engine. Resolves to a `world` object consumed by the viewer UI.
   */
  async build(engine, onProgress = () => {}) {
    const yieldFrame = () => new Promise((r) => requestAnimationFrame(r));
    let built;
    // buildWorld is synchronous; progress callbacks are reported before heavy steps, so give the UI a frame.
    await yieldFrame();
    built = buildWorld(engine, (p, label) => onProgress(p * 0.8, label));
    await yieldFrame();

    onProgress(0.84, 'Gulls, boats and clouds');
    const ambient = createAmbient({ scene: engine.scene, heightAt, seed: 7 });
    onProgress(0.9, 'Loading the guns');
    const fx = createSiegeFX({
      scene: engine.scene, heightAt,
      isInsideCity,
      roofHeightAt: (x, z) => heightAt(x, z) + 12,
      textures: { soft: softSpriteTexture(128) },
    });
    const modes = createModes({ engine, built, fx, content });

    const facade = built.materials.facade;
    engine.onTimeChanged = (e) => {
      ambient.setDay(e.day);
      facade.emissiveIntensity = (1 - e.day) * 1.6;
      built.materials.canopy.color.setScalar(0.75 + 0.25 * e.day);
      // fake floodlighting of the walls at night
      for (const m of [built.materials.stone, built.materials.stoneDark]) { m.emissive.set(0xffb068); m.emissiveIntensity = (1 - e.day) * 0.22; }
    };
    engine.onTimeChanged(engine);

    const update = (dt, t) => {
      built.water.userData.update(dt, t, engine);
      ambient.update(dt, t);
      fx.update(dt, t);
      modes.update(dt, t);
    };
    const unregister = engine.registerUpdate(update);
    onProgress(1, 'Ready');

    return {
      id: 'dubrovnik',
      content,
      built,
      fx,
      ambient,
      heightAt,
      hotspots: built.hotspots,
      colliders: built.colliders,
      intro: INTRO,
      cameraFor(id) { return L.CAMERA[id] || L.CAMERA.overview; },
      setMode: modes.setMode,
      get mode() { return modes.mode; },
      setYear: modes.setYear,
      highlight: modes.highlight,
      pick: modes.pick,
      setDiorama: modes.setDiorama,
      siegeCamera(id) { return L.SIEGE_CAMERA[id] || L.CAMERA.overview; },
      siege: modes.siege,
      timelineRange: [700, 2026],
      dispose() {
        unregister();
        modes.siege.stop();
        ambient.dispose();
        fx.dispose();
        engine.scene.remove(built.group);
        built.group.traverse((o) => { o.geometry?.dispose?.(); });
      },
    };
  },
};
