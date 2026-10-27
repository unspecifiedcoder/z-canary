export type PublicAppTab = 'demo' | 'case' | 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence' | 'native';

/** Stable hash routes used by the landing page and direct judge links. */
export function tabForHash(hash: string): PublicAppTab {
  const routes: Record<string, PublicAppTab> = {
    '#maya-noor': 'case', '#create': 'create', '#recipient': 'recipient', '#evidence': 'evidence', '#native': 'native',
  };
  return routes[hash.toLowerCase()] ?? 'welcome';
}
