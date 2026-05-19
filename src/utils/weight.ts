/**
 * Parse KG weight from a variant title.
 * Accepts: "20kg", "20 kg", "20KG", "15.5kg"
 * Returns null for anything that doesn't match — those variants are ignored
 * by the weight stock system entirely.
 */
export function parseWeightKg(title: string): number | null {
  const match = title.trim().match(/^(\d+(?:\.\d+)?)\s*kg$/i)
  if (!match) return null
  const kg = parseFloat(match[1])
  return kg > 0 ? kg : null
}
