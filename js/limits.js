// =============================================================================
// LIMITS — how many rows a view draws, and nothing else.
//
// These used to be a two-tier table: a free ceiling and a paid one. The tier is
// gone. What is left is the only reason a cap ever had to exist — a table of
// twenty thousand rows is slower to paint than it is useful to read, and
// replaying a pool's whole history costs the reader's own connection.
//
// So every number here is a rendering or fetching cost, not a lever. Where a
// cap bites, the view says so and says what narrows it, because a visitor
// cannot otherwise tell whether a row is missing or the data simply ends.
// =============================================================================

const CAPS = {
  pools: 600,
  tokens: 500,
  farms: 400,
  routes: 300,
  swaps: 600,
  holders: 100,

  // The two that cost the reader's connection rather than their CPU: each pool
  // replayed is a handful of history calls, and each is paid for by whoever
  // opened the page.
  tokenPools: 6,
  tokenTape: 300,
};

export const cap = name => CAPS[name] ?? Infinity;
