// Types for tests/guide-site.test.ts; not published (excluded in _config.yml).
export interface TargetInfo { id: string; label: string; start: string }
export interface ReleaseAsset { name: string; size: number; browser_download_url: string }
export interface PackageLink { target: string; name: string; size: number; url: string; label: string; start: string }
export const TARGETS: TargetInfo[];
export function classifyAssets(assets: ReleaseAsset[] | null | undefined): { packages: PackageLink[]; sums: string | null };
export function detectTarget(info?: { platform?: string; architecture?: string; userAgent?: string; override?: string }): string | null;
export function formatSize(bytes: number): string;
