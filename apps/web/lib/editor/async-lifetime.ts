// Tickets belong to a mounted effect session, not just a resource ID.
export class AsyncLifetime {
  private mounted = false;
  private generation = 0;

  // Setup must reactivate the instance on StrictMode replay, with fresh tickets.
  mount() { this.generation++; this.mounted = true; }
  unmount() { this.mounted = false; this.generation++; }
  invalidate() { this.generation++; }
  capture() { return this.generation; }
  isCurrent(ticket: number) { return this.mounted && ticket === this.generation; }
}
