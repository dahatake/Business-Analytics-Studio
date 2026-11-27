import type { WorkflowExtension } from '../../src/data/extensionSchemas.ts';

export function workflowAnswer(prompt: string): { workflow: WorkflowExtension } {
  const input = JSON.parse(prompt.split('\n')[2]!) as { existing: WorkflowExtension | null; lang: 'ja' | 'en' };
  const text = (ja: string, en: string) => input.lang === 'ja' ? ja : en;
  const base = input.existing ?? {
    parties: [{ id: 'party-test', name: text('担当チーム', 'Responsible team'), side: 'internal' }],
    phases: [{ id: 'phase-test', name: text('受付から完了', 'Intake to completion') }],
    stages: [{ id: 'stage-test', name: text('受付', 'Intake'), inputs: [], activities: [], outputs: [], next: [] }],
  };
  const party = base.parties?.[0] ?? { id: 'party-test', name: text('担当チーム', 'Responsible team'), side: 'internal' as const };
  const phase = base.phases?.[0] ?? { id: 'phase-test', name: text('受付から完了', 'Intake to completion') };
  const metrics = { touchMinutes: 30, waitHours: 4, volumePerMonth: 20, firstPassPct: 90, people: 1, basis: 'estimate' as const };
  return { workflow: {
    ...base, title: base.title ?? text('業務プロセス（概算ドラフト）', 'Business process (provisional draft)'),
    parties: base.parties?.length ? base.parties : [party], phases: base.phases?.length ? base.phases : [phase],
    laborCostPerHourJpy: base.laborCostPerHourJpy ?? 4000,
    draftNote: text('仮説として作成。担当者による確認が必要です。', 'Hypothesis; confirmation by the owner is needed.'),
    stages: base.stages.map((s) => ({
      ...s, partyId: s.partyId ?? party.id, phaseId: s.phaseId ?? phase.id, description: s.description || text('作業内容の仮説', 'Work hypothesis'),
      inputs: s.inputs.length ? s.inputs : [{ name: text('依頼情報', 'Request'), form: 'email' }],
      outputs: s.outputs.length ? s.outputs : [{ name: text('結果', 'Result'), form: 'document' }],
      activities: s.activities.length ? s.activities : [text('内容を確認する', 'Review the request')],
      data: s.data?.length ? s.data : [text('作業記録', 'Work records')], hiddenWork: s.hiddenWork ?? [], handoffTo: s.handoffTo ?? [],
      asIs: { ...metrics, ...s.asIs },
      toBe: { change: 'improve', basis: 'hypothesis', note: text('待ち時間が短い状態', 'Shorter waiting time'), ...s.toBe, metrics: { ...metrics, ...s.toBe?.metrics } },
    })),
    loops: base.loops ?? [],
  } };
}
