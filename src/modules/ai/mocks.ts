import { registerMock } from '../../ai/client.ts';
import { selectOutbound } from '../../ai/redact.ts';
import { loaded } from '../../data/pack.ts';
import type { Entity } from '../../data/schema.ts';
import { buildExplanation, explanationText } from './explain.ts';
import { reviewMock } from './review.ts';

const shareable = (e: Entity) => selectOutbound([e], loaded.byId).included.length > 0;

/**
 * Deterministic mocks (FR-011, C-07). Each one sees only what the gate would have sent: shareable entities
 * (selectOutbound) — so a mock answer never reveals more than a real model could have received.
 */
registerMock('explain', (req) => explanationText(buildExplanation(req.entities ?? [], shareable), req.lang));
registerMock('review', (req) => reviewMock(req.lang, req.prompt));
