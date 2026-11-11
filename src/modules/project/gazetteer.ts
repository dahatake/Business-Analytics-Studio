/**
 * Coordinates of major business cities (city centre, about ±0.1°), so a generated pack can place an office the
 * material names only by city without the model guessing coordinates. Keys are matched without case, spaces or
 * a trailing 市/都/県 ("Tokyo", "東京", "東京都" → Tokyo).
 */
const CITIES: [names: string[], lat: number, lon: number][] = [
  [['tokyo', '東京'], 35.68, 139.76],
  [['yokohama', '横浜'], 35.44, 139.64],
  [['osaka', '大阪'], 34.69, 135.5],
  [['nagoya', '名古屋'], 35.18, 136.91],
  [['kyoto', '京都'], 35.01, 135.77],
  [['fukuoka', '福岡'], 33.59, 130.4],
  [['sapporo', '札幌'], 43.06, 141.35],
  [['sendai', '仙台'], 38.27, 140.87],
  [['hiroshima', '広島'], 34.39, 132.46],
  [['seoul', 'ソウル'], 37.57, 126.98],
  [['beijing', '北京'], 39.9, 116.41],
  [['shanghai', '上海'], 31.23, 121.47],
  [['shenzhen', '深圳', '深セン'], 22.54, 114.06],
  [['hongkong', '香港'], 22.32, 114.17],
  [['taipei', '台北'], 25.03, 121.57],
  [['singapore', 'シンガポール'], 1.35, 103.82],
  [['bangkok', 'バンコク'], 13.76, 100.5],
  [['kualalumpur', 'クアラルンプール'], 3.14, 101.69],
  [['jakarta', 'ジャカルタ'], -6.2, 106.85],
  [['manila', 'マニラ'], 14.6, 120.98],
  [['hochiminhcity', 'hochiminh', 'ホーチミン'], 10.82, 106.63],
  [['hanoi', 'ハノイ'], 21.03, 105.85],
  [['bengaluru', 'bangalore', 'ベンガルール', 'バンガロール'], 12.97, 77.59],
  [['mumbai', 'ムンバイ'], 19.08, 72.88],
  [['newdelhi', 'delhi', 'ニューデリー', 'デリー'], 28.61, 77.21],
  [['hyderabad', 'ハイデラバード'], 17.39, 78.49],
  [['sydney', 'シドニー'], -33.87, 151.21],
  [['melbourne', 'メルボルン'], -37.81, 144.96],
  [['auckland', 'オークランド'], -36.85, 174.76],
  [['dubai', 'ドバイ'], 25.2, 55.27],
  [['riyadh', 'リヤド'], 24.71, 46.68],
  [['doha', 'ドーハ'], 25.29, 51.53],
  [['telaviv', 'テルアビブ'], 32.09, 34.78],
  [['istanbul', 'イスタンブール'], 41.01, 28.98],
  [['cairo', 'カイロ'], 30.04, 31.24],
  [['johannesburg', 'ヨハネスブルグ'], -26.2, 28.05],
  [['nairobi', 'ナイロビ'], -1.29, 36.82],
  [['lagos', 'ラゴス'], 6.52, 3.38],
  [['london', 'ロンドン'], 51.51, -0.13],
  [['dublin', 'ダブリン'], 53.35, -6.26],
  [['paris', 'パリ'], 48.86, 2.35],
  [['berlin', 'ベルリン'], 52.52, 13.4],
  [['munich', 'münchen', 'ミュンヘン'], 48.14, 11.58],
  [['frankfurt', 'フランクフルト'], 50.11, 8.68],
  [['amsterdam', 'アムステルダム'], 52.37, 4.9],
  [['brussels', 'ブリュッセル'], 50.85, 4.35],
  [['zurich', 'zürich', 'チューリッヒ'], 47.38, 8.54],
  [['milan', 'milano', 'ミラノ'], 45.46, 9.19],
  [['rome', 'roma', 'ローマ'], 41.9, 12.5],
  [['madrid', 'マドリード', 'マドリッド'], 40.42, -3.7],
  [['barcelona', 'バルセロナ'], 41.39, 2.17],
  [['lisbon', 'lisboa', 'リスボン'], 38.72, -9.14],
  [['stockholm', 'ストックホルム'], 59.33, 18.07],
  [['copenhagen', 'コペンハーゲン'], 55.68, 12.57],
  [['oslo', 'オスロ'], 59.91, 10.75],
  [['helsinki', 'ヘルシンキ'], 60.17, 24.94],
  [['warsaw', 'ワルシャワ'], 52.23, 21.01],
  [['prague', 'プラハ'], 50.08, 14.44],
  [['vienna', 'wien', 'ウィーン'], 48.21, 16.37],
  [['redmond', 'レドモンド'], 47.67, -122.12],
  [['seattle', 'シアトル'], 47.61, -122.33],
  [['sanfrancisco', 'サンフランシスコ'], 37.77, -122.42],
  [['siliconvalley', 'mountainview', 'シリコンバレー', 'マウンテンビュー'], 37.39, -122.08],
  [['losangeles', 'ロサンゼルス'], 34.05, -118.24],
  [['newyork', 'newyorkcity', 'ニューヨーク'], 40.71, -74.01],
  [['boston', 'ボストン'], 42.36, -71.06],
  [['chicago', 'シカゴ'], 41.88, -87.63],
  [['washingtondc', 'washington', 'ワシントン'], 38.91, -77.04],
  [['reston', 'レストン'], 38.96, -77.36],
  [['atlanta', 'アトランタ'], 33.75, -84.39],
  [['dallas', 'ダラス'], 32.78, -96.8],
  [['houston', 'ヒューストン'], 29.76, -95.37],
  [['austin', 'オースティン'], 30.27, -97.74],
  [['detroit', 'デトロイト'], 42.33, -83.05],
  [['toronto', 'トロント'], 43.65, -79.38],
  [['vancouver', 'バンクーバー'], 49.28, -123.12],
  [['montreal', 'モントリオール'], 45.5, -73.57],
  [['mexicocity', 'メキシコシティ'], 19.43, -99.13],
  [['saopaulo', 'são paulo', 'サンパウロ'], -23.55, -46.63],
  [['riodejaneiro', 'リオデジャネイロ'], -22.91, -43.17],
  [['buenosaires', 'ブエノスアイレス'], -34.6, -58.38],
  [['santiago', 'サンティアゴ'], -33.45, -70.67],
  [['bogota', 'bogotá', 'ボゴタ'], 4.71, -74.07],
  [['lima', 'リマ'], -12.05, -77.04],
];

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s.\-_'’]/g, '').replace(/(市|都|府|県)$/, '');

const INDEX = new Map<string, [number, number]>();
for (const [names, lat, lon] of CITIES) for (const n of names) INDEX.set(norm(n), [lat, lon]);

/** [lat, lon] of a known city (first part of "City, Country" also tried), or null. */
export function cityLatLon(city: string): [number, number] | null {
  if (!city.trim()) return null;
  const whole = INDEX.get(norm(city));
  if (whole) return whole;
  const first = city.split(/[,、，/（(]/)[0] ?? '';
  return INDEX.get(norm(first)) ?? null;
}

/**
 * Sites that name a known `city` get that city's coordinates (the model's own guesses are replaced);
 * returns the ids it placed. The pack is changed in place.
 */
export function placeSitesByCity(pack: Record<string, unknown>): string[] {
  const placed: string[] = [];
  const ents = Array.isArray(pack.entities) ? (pack.entities as Record<string, unknown>[]) : [];
  for (const e of ents) {
    if (e.kind !== 'site') continue;
    const c = e.city;
    const names = typeof c === 'string' ? [c] : c && typeof c === 'object' ? [(c as Record<string, unknown>).en, (c as Record<string, unknown>).ja].filter((v): v is string => typeof v === 'string') : [];
    const ll = names.map(cityLatLon).find((v) => v !== null) ?? null;
    if (!ll) continue;
    e.lat = ll[0];
    e.lon = ll[1];
    placed.push(String(e.id));
  }
  return placed;
}
