import * as workspace from '../modules/workspace/global.tsx';
import * as show from '../modules/show/global.tsx';
import * as project from '../modules/project/global.tsx';
import * as ai from '../modules/ai/global.tsx';
import * as ink from '../modules/ink/global.tsx';
import * as threed from '../modules/threed/global.tsx';
import * as graph from '../modules/graph/global.tsx';
import * as usecases from '../modules/usecases/global.tsx';
import * as ops from '../modules/ops/global.tsx';

const MODULES = [project, workspace, show, ai, ink, threed, graph, usecases, ops];
/** Modules whose top-bar controls are commands (second row). The project module provides the work context (first row). */
const ACTION_MODULES = [workspace, show, ai, ink, threed, graph, usecases, ops];

/** First row: where the user is working (work-target menu, stepper, export). */
export function ContextSlot() {
  return <project.TopBarSlot />;
}

/** Second row: module commands (command palette, presentation, AI, ink). */
export function ActionSlots() {
  return (
    <>
      {ACTION_MODULES.map((m, i) => <m.TopBarSlot key={i} />)}
    </>
  );
}

/** Module-provided overlays mounted once (e.g. command palette, presentation layer, confirmations). */
export function Overlays() {
  return (
    <>
      {MODULES.map((m, i) => <m.Overlay key={i} />)}
    </>
  );
}
