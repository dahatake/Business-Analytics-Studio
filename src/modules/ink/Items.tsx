import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { Delete16Regular, Edit16Regular, ThumbLike16Regular, Color16Regular } from '@fluentui/react-icons';
import { getEntity } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { isHidden } from '../../ui/cardSpecs.ts';
import { itemCenter, type BoardContent, type Card, type Note } from './model.ts';

export interface ItemHandlers {
  onPointerDown: (e: RPointerEvent<HTMLElement>, id: string, mode: 'move' | 'resize') => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, id: string) => void;
  onFocusItem: (id: string) => void;
  onEdit: (id: string) => void;
  onSaveText: (id: string, text: string | null) => void;
  onVote: (id: string) => void;
  onCycleColor: (id: string) => void;
  onDelete: (id: string) => void;
}

function ItemActions({ id, note, h }: { id: string; note: boolean; h: ItemHandlers }) {
  const { t } = useI18n();
  return (
    <div className="ink-item-actions">
      {note && (
        <>
          <Tooltip content={t('ink.note.editAction')} relationship="label">
            <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => h.onEdit(id)} />
          </Tooltip>
          <Tooltip content={t('ink.note.vote')} relationship="label">
            <Button size="small" appearance="subtle" icon={<ThumbLike16Regular />} onClick={() => h.onVote(id)} />
          </Tooltip>
          <Tooltip content={t('ink.note.color')} relationship="label">
            <Button size="small" appearance="subtle" icon={<Color16Regular />} onClick={() => h.onCycleColor(id)} />
          </Tooltip>
        </>
      )}
      <Tooltip content={t('ink.item.delete')} relationship="label">
        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => h.onDelete(id)} />
      </Tooltip>
    </div>
  );
}

function NoteEditor({ note, onSave }: { note: Note; onSave: (text: string | null) => void }) {
  const { t, lang } = useI18n();
  const [value, setValue] = useState(loc(note.text, lang));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      className="ink-note-input"
      aria-label={t('ink.note.edit')}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onSave(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onSave(null);
        }
      }}
      onBlur={() => onSave(value)}
    />
  );
}

export function NoteView({ note, selected, editing, linkSource, h }: { note: Note; selected: boolean; editing: boolean; linkSource: boolean; h: ItemHandlers }) {
  const { t, lang } = useI18n();
  const text = loc(note.text, lang);
  return (
    <div
      data-ink-item={note.id}
      data-testid="ink-note"
      role="group"
      tabIndex={0}
      aria-label={t('ink.note.label', { text: text || t('ink.note.empty'), votes: note.votes })}
      aria-current={selected ? 'true' : undefined}
      className={`ink-item ink-note ink-note-${note.color}${selected ? ' is-selected' : ''}${linkSource ? ' is-link-source' : ''}`}
      style={{ left: note.x, top: note.y, width: note.w, height: note.h }}
      onPointerDown={(e) => h.onPointerDown(e, note.id, 'move')}
      onKeyDown={(e) => h.onKeyDown(e, note.id)}
      onFocus={(e) => e.target === e.currentTarget && h.onFocusItem(note.id)}
      onDoubleClick={() => h.onEdit(note.id)}
    >
      {editing ? <NoteEditor note={note} onSave={(v) => h.onSaveText(note.id, v)} /> : <p className="ink-note-text">{text || t('ink.note.empty')}</p>}
      {note.votes > 0 && <span className="ink-votes">{t('ink.note.votes', { count: note.votes })}</span>}
      {selected && !editing && <ItemActions id={note.id} note h={h} />}
      <span className="ink-resize" aria-hidden onPointerDown={(e) => h.onPointerDown(e, note.id, 'resize')} />
    </div>
  );
}

export function CardView({ card, selected, linkSource, h }: { card: Card; selected: boolean; linkSource: boolean; h: ItemHandlers }) {
  const { t, tx } = useI18n();
  const audience = useSettings((s) => s.audience);
  const e = getEntity(card.entityId);
  const name = !e ? card.entityId : isHidden(e, audience) ? t('card.restrictedName') : tx(e.name);
  return (
    <div
      data-ink-item={card.id}
      data-testid="ink-card"
      role="group"
      tabIndex={0}
      aria-label={t('ink.card.label', { name })}
      aria-current={selected ? 'true' : undefined}
      className={`ink-item ink-card${selected ? ' is-selected' : ''}${linkSource ? ' is-link-source' : ''}`}
      style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
      onPointerDown={(ev) => h.onPointerDown(ev, card.id, 'move')}
      onKeyDown={(ev) => h.onKeyDown(ev, card.id)}
      onFocus={(ev) => ev.target === ev.currentTarget && h.onFocusItem(card.id)}
    >
      <span className="ink-card-kind">{e ? t(`kind.${e.kind}` as MessageKey) : t('ink.card.missing')}</span>
      {e ? <EntityRef id={card.entityId} /> : <span>{card.entityId}</span>}
      {selected && <ItemActions id={card.id} note={false} h={h} />}
      <span className="ink-resize" aria-hidden onPointerDown={(ev) => h.onPointerDown(ev, card.id, 'resize')} />
    </div>
  );
}

/** Links between items, drawn as SVG lines with arrowheads (decorative; listed accessibly in the items panel). */
export function LinksLayer({ content }: { content: BoardContent }) {
  return (
    <svg className="ink-links" aria-hidden width="1" height="1">
      <defs>
        <marker id="ink-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {content.links.map((l) => {
        const a = itemCenter(content, l.from);
        const b = itemCenter(content, l.to);
        if (!a || !b) return null;
        const target = [...content.notes, ...content.cards].find((i) => i.id === l.to)!;
        // Stop the arrow at the target's border.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const k = Math.min(Math.abs((target.w / 2) / (dx || 1e-9)), Math.abs((target.h / 2) / (dy || 1e-9)), 1);
        return <line key={l.id} x1={a.x} y1={a.y} x2={b.x - dx * k} y2={b.y - dy * k} stroke="currentColor" strokeWidth={2} markerEnd="url(#ink-arrow)" />;
      })}
    </svg>
  );
}
