// mango-code: the price of a model of a server (a cloud service says it: OpenRouter), in US dollars per million tokens.

export type ServerPrice = { input: number; output: number }

/** As the user reads it: two decimals, or more for a price under one cent; free when both are zero. */
export function serverPrice(price: ServerPrice | undefined, locale: string) {
  if (!price) return
  if (price.input === 0 && price.output === 0) return { kind: "free" as const }
  const dollars = (value: number) =>
    value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 4 })
  return { kind: "paid" as const, input: dollars(price.input), output: dollars(price.output) }
}
