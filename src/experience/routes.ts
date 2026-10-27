export type PublicAppTab = 'demo' | 'case' | 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence' | 'native';

const directRoutes: Record<string, PublicAppTab> = {
  '#maya-noor': 'case', '#create': 'create', '#recipient': 'recipient', '#evidence': 'evidence', '#native': 'native',
};

/** Returns a page only for hashes Canary explicitly owns. Ordinary in-page anchors are ignored. */
export function tabForDirectHash(hash: string): PublicAppTab | null {
  return directRoutes[hash.toLowerCase()] ?? null;
}

/** Stable initial route used by the landing page and direct judge links. */
export function tabForHash(hash: string): PublicAppTab {
  return tabForDirectHash(hash) ?? 'welcome';
}
