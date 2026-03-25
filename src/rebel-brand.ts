/**
 * Rebel Group Brand Configuration
 * Source: https://github.com/Rebel-Data/brandingportal (rgmp.net/brand)
 */

export const REBEL_BRAND = {
  colors: {
    rebelBlue: "#152b4e",
    rebelRed: "#ef4035",
    white: "#ffffff",
    blueMedium: "#3267b1",
    blueLight: "#6d89c5",
    periwinkle: "#afbfff",
    blueOffwhite: "#f0f4fc",
    maroon: "#7b0000",
    redDark: "#b70000",
    redPure: "#ff0000",
    coralLight: "#ff8686",
  },
  typography: {
    serif: "'FreightBig Pro', 'Palatino Linotype', Palatino, Georgia, serif",
    sansSerif: "'FreightSans Pro', Ebrima, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', monospace",
  },
  grid: {
    maxWidth: 1280,
    margins: { mobile: 16, tablet: 32, desktop: 64, widescreen: 80 },
    columns: { mobile: 4, tablet: 8, desktop: 12 },
    gutters: { mobile: 16, tablet: 24, desktop: 24 },
  },
  principles: [
    "Clarity: every element serves a clear purpose",
    "Context: frame information with scope and relevance",
    "Storytelling: beginning, middle, end",
    "User-centred: design for audience",
    "Visualisation: show data visually",
    "Brand consistency: maintain visual style",
    "Rebellious: break conventions when it serves the message",
  ],
} as const;

export function generateCSSVariables(): string {
  const c = REBEL_BRAND.colors;
  return `:root {
  --rebel-blue: ${c.rebelBlue};
  --rebel-red: ${c.rebelRed};
  --rebel-white: ${c.white};
  --rebel-blue-medium: ${c.blueMedium};
  --rebel-blue-light: ${c.blueLight};
  --rebel-periwinkle: ${c.periwinkle};
  --rebel-blue-offwhite: ${c.blueOffwhite};
  --rebel-maroon: ${c.maroon};
  --rebel-red-dark: ${c.redDark};
  --font-serif: ${REBEL_BRAND.typography.serif};
  --font-sans: ${REBEL_BRAND.typography.sansSerif};
  --font-mono: ${REBEL_BRAND.typography.mono};
}`;
}
