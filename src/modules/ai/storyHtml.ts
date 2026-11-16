import { StoryScenes } from '../../ai/storyOutput.ts';
import type { StoryVideo } from './story.ts';

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Only this fixed player executes. Model text is escaped HTML, never code, URLs, CSS or script data. */
export function storyHtml(video: StoryVideo, options: { embedded?: boolean; sceneIndex?: number } = {}): string {
  const allScenes = StoryScenes.parse(video.scenes);
  const scenes = options.sceneIndex === undefined ? allScenes : allScenes.filter((_, index) => index === options.sceneIndex);
  const ja = video.lang === 'ja';
  const labels = ja
    ? { play: '再生', pause: '一時停止', restart: '最初から', mock: '端末内の簡易版（AI未使用）', live: 'AI生成・内容は要確認', source: '元データ' }
    : { play: 'Play', pause: 'Pause', restart: 'Restart', mock: 'Local preview (no AI)', live: 'AI-generated; review required', source: 'Source' };
  return `<!doctype html>
<html lang="${ja ? 'ja' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escape(scenes[0]!.title)}</title>
<style>
body{margin:0;padding:clamp(16px,5vw,64px);font:20px/1.6 system-ui,sans-serif;background:#101b30;color:#f5f8ff}
main{max-width:1000px;margin:auto}button{padding:10px 24px;margin:6px;border:2px solid #9bcaff;border-radius:8px;background:#19385c;color:inherit;font:inherit;cursor:pointer}
button:focus-visible{outline:3px solid #fff;outline-offset:3px}ol{list-style:none;padding:0}li{padding:24px;border-left:5px solid #83c8ff;margin:24px 0;background:#172b46;overflow-wrap:anywhere}
li[hidden]{display:none}h1{font-size:clamp(24px,5vw,46px);line-height:1.2}small{display:block;overflow-wrap:anywhere}
@media(prefers-reduced-motion:no-preference){.playing li{animation:reveal .4s ease-out}@keyframes reveal{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}}
</style></head><body><main>
<p>${escape(video.mode === 'live' ? labels.live : labels.mock)}</p>
${options.embedded ? '' : `<nav><button id="play" type="button" aria-pressed="false">${labels.play}</button><button id="restart" type="button">${labels.restart}</button></nav>`}
<p id="position" role="status"></p><ol>${scenes.map((scene) => `<li data-ms="${scene.durationMs}"><h1>${escape(scene.title)}</h1><p>${escape(scene.narration)}</p></li>`).join('')}</ol>
<small>${labels.source}: ${escape(video.sourceId)} | ${escape(video.sourceUpdatedAt)} | ${escape(video.createdAt)}</small>
</main>${options.embedded ? '' : `<script>
(()=>{const scenes=[...document.querySelectorAll('li')],play=document.getElementById('play'),restart=document.getElementById('restart'),position=document.getElementById('position'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
let index=0,playing=false,timer,started=0,remaining=Number(scenes[0].dataset.ms);
function render(){scenes.forEach((s,i)=>s.hidden=!reduced.matches&&i!==index);play.textContent=playing?'${labels.pause}':'${labels.play}';play.setAttribute('aria-pressed',String(playing));document.body.classList.toggle('playing',playing);position.textContent=(index+1)+' / '+scenes.length;}
function schedule(){started=performance.now();timer=setTimeout(()=>{if(index===scenes.length-1){playing=false;remaining=Number(scenes[index].dataset.ms);render();return;}index++;remaining=Number(scenes[index].dataset.ms);render();schedule();},remaining);}
play.onclick=()=>{if(reduced.matches)return;if(playing){clearTimeout(timer);remaining=Math.max(0,remaining-(performance.now()-started));playing=false;}else{playing=true;schedule();}render();};
restart.onclick=()=>{clearTimeout(timer);playing=false;index=0;remaining=Number(scenes[0].dataset.ms);render();};
reduced.onchange=()=>{restart.click();play.hidden=reduced.matches;};play.hidden=reduced.matches;render();
})();
</script>`}</body></html>`;
}
