export function q32ToPrice(
  q32Price: bigint,
  baseLotExp: number,
  quoteLotExp: number,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  return (
    Number(q32Price) /
    2 ** 32 /
    2 ** (quoteLotExp - quoteDecimals) *
    2 ** (baseLotExp - baseDecimals)
  );
}

export function priceToQ32(
  price: number,
  baseLotExp: number,
  quoteLotExp: number,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  return BigInt(
    Math.round(
      price *
        2 ** 32 *
        2 ** (quoteLotExp - quoteDecimals) /
        2 ** (baseLotExp - baseDecimals),
    ),
  );
}
