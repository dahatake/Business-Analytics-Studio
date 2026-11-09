import type { MessageKey } from '../i18n/index.ts';

/** §4 personas that have a persona view (FR-015). The facilitator presents; the maintainer works from the CLI. */
export const PERSONA_VIEWS = ['executive', 'business', 'it', 'field'] as const;
export type PersonaView = (typeof PERSONA_VIEWS)[number];

export const ALL_PERSONAS = ['facilitator', ...PERSONA_VIEWS, 'planner', 'leader'] as const;
export type Persona = (typeof ALL_PERSONAS)[number];

export const personaLabel = (p: Persona): MessageKey => `persona.${p}`;
