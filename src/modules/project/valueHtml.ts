import { valueEngine, type EngineModel } from './valueEngine.ts';

/**
 * FR-327: the value model as one interactive HTML file. Unlike a generated report, the numbers are recomputed in the
 * file by the same engine the app uses (its source is embedded), so toggling a solution or the discount rate gives the
 * app's answer. Data travels as JSON text (never as markup or code); only this fixed script runs.
 */

export interface ValueHtmlInput {
  model: EngineModel;
  lang: 'ja' | 'en';
  title: string;
  /** Solution id → display name (already masked for the audience). */
  names: Record<string, string>;
  /** Benefit line id → label, for the tornado. */
  lineLabels: Record<string, string>;
  createdAt: string;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
/** JSON safe inside a script element: no `<` (so no `</script>`), no line separators. */
const jsonText = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const LABELS = {
  ja: {
    lead: '施策ポートフォリオの価値（正味現在価値）を、Business Analytics Studio と同じ計算で再計算します。値は Project で人が入力した見積もりと前提で、効果を保証するものではありません。',
    portfolio: '施策（チェックを外すとポートフォリオから除く）', rate: '割引率', horizon: '効果を数える年数', years: '年',
    result: '結果', p50: 'NPV（中央値 P50）', range: 'P10〜P90', positive: 'NPV がプラスになる確率', payback: '割引回収期間', never: '期間内に回収しない',
    stress: 'ブラックスワンの試算（最大の施策の費用 +400%・効果 37.5%）', drivers: '価値の内訳（最頻値）', driver: '価値の源泉', pv: '現在価値',
    solutions: '単独の価値と、ポートフォリオでの限界価値', solution: '施策', standalone: '単独', marginal: '限界', tornado: '結果を最も動かす前提（トルネード）',
    input: '前提', low: '下限のとき', high: '上限のとき', hist: 'NPV の分布', bin: '区間', count: '回数', disabled: '前提の施策が外れているため効果なし',
    kind: { amount: '金額', conversion: '現金化の割合', cost: '費用', rate: '割引率' },
    lever: { investment: '投資', revenue: '売上・粗利', cost: 'コスト削減', capital: '資本（運転資本・設備）', risk: 'リスク低減', option: '将来の選択肢', unclassified: '未分解の年間効果', disbenefit: '負の効果（運用費など）' },
    total: 'NPV', created: '作成日', runs: '試行回数', irr: 'NPV が 0 になる割引率（IRR）',
  },
  en: {
    lead: 'Recomputes the net present value of the solution portfolio with the same calculation as Business Analytics Studio. The values are estimates and assumptions people entered in the project, not a guarantee of results.',
    portfolio: 'Solutions (clear to leave out of the portfolio)', rate: 'Discount rate', horizon: 'Years of benefits counted', years: 'years',
    result: 'Result', p50: 'NPV (median P50)', range: 'P10 to P90', positive: 'Probability that NPV is positive', payback: 'Discounted payback', never: 'Does not pay back within the horizon',
    stress: 'Black-swan check (largest solution cost +400%, 37.5% of benefits)', drivers: 'Value by driver (most likely)', driver: 'Driver', pv: 'Present value',
    solutions: 'Standalone value and marginal value in the portfolio', solution: 'Solution', standalone: 'Standalone', marginal: 'Marginal', tornado: 'Assumptions that move the result most (tornado)',
    input: 'Assumption', low: 'At low end', high: 'At high end', hist: 'Distribution of NPV', bin: 'Range', count: 'Runs', disabled: 'No benefit: its enabling solution is left out',
    kind: { amount: 'amount', conversion: 'cash conversion', cost: 'cost', rate: 'discount rate' },
    lever: { investment: 'Investment', revenue: 'Revenue and margin', cost: 'Cost reduction', capital: 'Capital (working capital, capex)', risk: 'Risk reduction', option: 'Future options', unclassified: 'Undecomposed annual benefit', disbenefit: 'Dis-benefits (running cost etc.)' },
    total: 'NPV', created: 'Created', runs: 'Runs', irr: 'Discount rate at which NPV is zero (IRR)',
  },
} as const;

const SCRIPT = `(()=>{
const engine=(${String(valueEngine)});
const D=JSON.parse(document.getElementById('vh-data').textContent);
const L=D.labels,$=(id)=>document.getElementById(id);
const nf=new Intl.NumberFormat(D.lang==='ja'?'ja-JP':'en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
const yen=(v)=>{const m=nf.format(Math.abs(v)/1e6);return (v<0?'\\u2212':'')+(D.lang==='ja'?m+' \\u767e\\u4e07\\u5186':'\\u00a5'+m+'M');};
const pct=(v)=>Math.round(v*100)+'%';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const bar=(v,max)=>{const w=el('span','','bar'+(v<0?' neg':''));w.style.width=(max>0?Math.abs(v)/max*100:0)+'%';const t=el('span','','track');t.appendChild(w);return t;};
const rows=(id,list)=>{const b=$(id);b.replaceChildren();for(const cells of list){const tr=el('tr');cells.forEach((c,i)=>{const td=el(i===0?'th':'td');if(i===0)td.scope='row';if(c instanceof Node)td.appendChild(c);else td.textContent=c;if(i>0&&!(c instanceof Node))td.className='num';tr.appendChild(td);});b.appendChild(tr);}};
const set=(id,text,value)=>{const e=$(id);e.textContent=text;if(value!==undefined)e.setAttribute('data-value',String(value));};
const name=(id)=>D.names[id]||id;
function render(){
  const selected=[...document.querySelectorAll('input[data-solution]')].filter((x)=>x.checked).map((x)=>x.getAttribute('data-solution'));
  const rate=Number($('vh-rate').value)/100,horizon=Number($('vh-horizon').value);
  set('vh-rate-out',(rate*100).toFixed(1)+'%');set('vh-horizon-out',horizon+' '+L.years);
  const r=engine(Object.assign({},D.model,{selected:selected,discountRate:rate,horizonYears:horizon}));
  set('vh-p50',yen(r.npv.p50),r.npv.p50);set('vh-range',yen(r.npv.p10)+' \\u2013 '+yen(r.npv.p90));
  set('vh-positive',pct(r.npv.pPositive),r.npv.pPositive);
  set('vh-payback',r.payback===null?L.never:r.payback.toFixed(1)+' '+L.years,r.payback===null?'':r.payback);
  set('vh-irr',r.irr===null?'\\u2013':(r.irr*100).toFixed(1)+'%',r.irr===null?'':r.irr);
  set('vh-stress',r.stress?yen(r.stress.npv)+' ('+name(r.stress.solutionId)+')':'\\u2013',r.stress?r.stress.npv:'');
  const order=['investment','revenue','cost','capital','risk','option','unclassified','disbenefit'];
  const lev=order.filter((k)=>r.levers[k]!==undefined),max=Math.max(1,Math.abs(r.npv.mode),...lev.map((k)=>Math.abs(r.levers[k])));
  rows('vh-drivers',[...lev.map((k)=>[L.lever[k],bar(r.levers[k],max),yen(r.levers[k])]),[L.total,bar(r.npv.mode,max),yen(r.npv.mode)]]);
  const smax=Math.max(1,...r.solutions.map((s)=>Math.max(Math.abs(s.standalone),Math.abs(s.marginal))));
  rows('vh-solutions',r.solutions.map((s)=>[name(s.id)+(s.selected&&!s.enabled?' \\u2014 '+L.disabled:''),yen(s.standalone),bar(s.marginal,smax),yen(s.marginal)]));
  rows('vh-tornado',r.tornado.map((b)=>[b.kind==='rate'?L.kind.rate:(b.kind==='cost'?name(b.ref):(D.lineLabels[b.ref]||b.ref))+' \\u00b7 '+L.kind[b.kind],yen(b.atLow),yen(b.atHigh)]));
  const w=(r.hist.hi-r.hist.lo)/r.hist.counts.length,cmax=Math.max(...r.hist.counts);
  rows('vh-hist',r.hist.counts.map((c,i)=>[yen(r.hist.lo+w*i)+' \\u2013 '+yen(r.hist.lo+w*(i+1)),bar(c,cmax),String(c)]));
}
document.addEventListener('input',render);document.addEventListener('change',render);render();
})();`;

export function valueHtml(input: ValueHtmlInput): string {
  const L = LABELS[input.lang];
  const ids = input.model.solutions.map((s) => s.id);
  const data = { lang: input.lang, labels: L, names: input.names, lineLabels: input.lineLabels, model: input.model };
  const ratePct = Math.round(input.model.discountRate * 1000) / 10;
  const table = (id: string, caption: string, heads: string[]) => `<table><caption>${escape(caption)}</caption><thead><tr>${heads.map((h) => `<th scope="col">${escape(h)}</th>`).join('')}</tr></thead><tbody id="${id}"></tbody></table>`;
  return `<!doctype html>
<html lang="${input.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escape(input.title)}</title>
<style>
body{margin:0;padding:clamp(12px,4vw,40px);font:16px/1.5 system-ui,sans-serif;color:#1b1b1b;background:#fff}
main{max-width:1100px;margin:auto}h1{font-size:1.6em;margin:0 0 .3em}fieldset{border:1px solid #8a8a8a;border-radius:6px;margin:12px 0;padding:8px 12px}
label{display:inline-flex;gap:6px;align-items:center;margin:4px 16px 4px 0;min-height:24px}input[type=range]{width:220px}
dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin:12px 0}dl div{border:1px solid #c7c7c7;border-radius:6px;padding:8px}
dt{font-size:.85em;color:#424242}dd{margin:0;font-size:1.3em;font-weight:600;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;margin:16px 0}caption{text-align:left;font-weight:600;font-size:1.1em;padding:4px 0}
th,td{border-bottom:1px solid #d1d1d1;padding:4px 8px;text-align:left;vertical-align:middle}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.track{display:block;min-width:160px;height:12px;background:#f0f0f0;border-radius:2px}.bar{display:block;height:12px;background:#0f6cbd;border-radius:2px}.bar.neg{background:#c50f1f;background-image:repeating-linear-gradient(45deg,transparent 0 3px,rgba(255,255,255,.5) 3px 6px)}
small{display:block;color:#424242;margin-top:16px}
@media(forced-colors:active){.bar{background:CanvasText;forced-color-adjust:none}.track{border:1px solid CanvasText}}
</style></head><body><main>
<h1>${escape(input.title)}</h1>
<p>${escape(L.lead)}</p>
<fieldset><legend>${escape(L.portfolio)}</legend>${ids.map((id) => `<label><input type="checkbox" data-solution="${escape(id)}"${input.model.selected.includes(id) ? ' checked' : ''}>${escape(input.names[id] ?? id)}</label>`).join('')}</fieldset>
<fieldset><legend>${escape(L.result)}</legend>
<label>${escape(L.rate)} <input id="vh-rate" type="range" min="0" max="30" step="0.5" value="${ratePct}"> <output id="vh-rate-out"></output></label>
<label>${escape(L.horizon)} <input id="vh-horizon" type="range" min="1" max="15" step="1" value="${input.model.horizonYears}"> <output id="vh-horizon-out"></output></label>
</fieldset>
<dl aria-live="polite">
<div><dt>${escape(L.p50)}</dt><dd id="vh-p50" data-testid="vh-p50"></dd></div>
<div><dt>${escape(L.range)}</dt><dd id="vh-range"></dd></div>
<div><dt>${escape(L.positive)}</dt><dd id="vh-positive" data-testid="vh-positive"></dd></div>
<div><dt>${escape(L.payback)}</dt><dd id="vh-payback"></dd></div>
<div><dt>${escape(L.stress)}</dt><dd id="vh-stress"></dd></div>
<div><dt>${escape(L.irr)}</dt><dd id="vh-irr" data-testid="vh-irr"></dd></div>
</dl>
${table('vh-drivers', L.drivers, [L.driver, '', L.pv])}
${table('vh-solutions', L.solutions, [L.solution, L.standalone, '', L.marginal])}
${table('vh-tornado', L.tornado, [L.input, L.low, L.high])}
${table('vh-hist', L.hist, [L.bin, '', L.count])}
<small>${escape(L.created)}: ${escape(input.createdAt)} | ${escape(L.runs)}: ${input.model.runs}</small>
</main>
<script type="application/json" id="vh-data">${jsonText(data)}</script>
<script>${SCRIPT}</script>
</body></html>`;
}
