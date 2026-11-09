import type * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DOF_APERTURE, DOF_MAX_BLUR } from './dof.ts';

/** FR-067 depth-of-field chain. Loaded on demand so the default (DOF off) path never pays for it. */
export interface DofChain {
  setSize: (pixelRatio: number, width: number, height: number, aspect: number) => void;
  render: (focus: number, deltaSec: number) => void;
  dispose: () => void;
}

export function createDofChain(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, focus: number): DofChain {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new BokehPass(scene, camera, { focus, aperture: DOF_APERTURE, maxblur: DOF_MAX_BLUR });
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());
  const uniforms = bokeh.uniforms as Record<'focus' | 'aspect', { value: number }>;
  return {
    setSize(pixelRatio, width, height, aspect) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      uniforms.aspect.value = aspect;
    },
    render(f, deltaSec) {
      uniforms.focus.value = f;
      composer.render(deltaSec);
    },
    dispose() {
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    },
  };
}
