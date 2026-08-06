export const MIX_BAR_OPTIONS = [4, 8, 16, 32] as const;

export type MixBars = (typeof MIX_BAR_OPTIONS)[number];

export const isDjMixFeatureAvailable = (enabled: boolean) => enabled;
