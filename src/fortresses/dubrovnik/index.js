import * as THREE from 'three';
import * as content from './content.js';
import * as L from './layout.js';
import { heightAt, cityPoly } from './terrain.js';
import { buildWorld } from './build.js';
import { createModes } from './modes.js';
import { createSiegeFX } from '../../app/siegefx.js';
import { createAmbient } from '../../app/ambient.js';
import { softSpriteTexture } from '../../app/textures.js';
import { pointInPolygon } from '../../app/geom.js';

/** Cinematic intro path (camera points) and look-at points. */
const INTRO = {
  points: [[1700, 520, 1500], [1000, 260, 980], [380, 110, 640], [-150, 120, 420], [-320, 180, 60], [-60, 230, -330], [500, 260, -380], [930, 430, 760]],
  lookAt: [[300, 20, 60], [300, 20, 60], [200, 25, 120], [-100, 40, 100], [60, 40, -60], [220, 30, -60], [260, 20, 20], [220, 20, 40]],
  duration: 26,
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
      isInsideCity: (x, z) => pointInPolygon([x, z], cityPoly),
      roofHeightAt: (x, z) => heightAt(x, z) + 11,
      textures: { soft: softSpriteTexture(128) },
    });
    const modes = createModes({ engine, built, fx, content });

    const facade = built.materials.facade;
    engine.onTimeChanged = (e) => {
      ambient.setDay(e.day);
      facade.emissiveIntensity = (1 - e.day) * 1.6;
      built.materials.canopy.color.setScalar(0.75 + 0.25 * e.day);
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
      heightAt,
      hotspots: built.hotspots,
      colliders: built.colliders,
      intro: INTRO,
      cameraFor(id) { return L.CAMERA[id] || L.CAMERA.overview; },
      setMode: modes.setMode,
      get mode() { return modes.mode; },
      setYear: modes.setYear,
      highlight: modes.highlight,
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
