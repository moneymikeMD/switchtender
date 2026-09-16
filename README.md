# switchtender

A switchtender is the railway worker who sets the switch at a junction,
deciding which track a train takes. This tool does the same thing for a
commute: at a configurable fork in the route, it reads live conditions and
tells you, out loud, whether to keep driving or park and take transit.

It is built for the case where both options share a common first leg, so
only the divergent legs matter to the decision.

**Status: in development.** Nothing here is usable yet.

## Design

Every location, venue and bounding box is configuration. The engine holds no
coordinates, so it runs against any commute with a comparable fork, not just
the one it was written for.

## License

MIT.
