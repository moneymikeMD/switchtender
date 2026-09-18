# Decisions

Dated log of decisions that need a durable home. Newest first.

## 2026-09-18 — CMB-36: push channel is ntfy.sh (public), not lab-ntfy or FCM

**Decision:** verdict-change alerts push via the public `ntfy.sh` instance, to a
fresh topic used for nothing else. Not the homelab's self-hosted `lab-ntfy`
instance, and not Firebase Cloud Messaging.

**Why ntfy over FCM:** the owner's installed ntfy app is the Google Play
build (FCM-backed under the hood), so delivery is reliable even with the app
closed. There is no existing switchtender Android app to hold an FCM device
token, so FCM directly would mean building one first — much bigger than
sending a push. ntfy needs only a topic name and a `curl -d`.

**Why public ntfy.sh over the self-hosted lab-ntfy:** the Cloud Run service
would otherwise need a path back into the owner's private network to reach
`lab-ntfy` — a new network dependency for a scale-to-zero public service.
ntfy.sh has no such requirement.

**Why a fresh topic, not the existing Grafana `lab-ntfy` contact point:**
least privilege — switchtender's credential and the homelab's infrastructure
alert channel should not share blast radius if either leaks. ntfy.sh's free
tier has no per-topic auth, so the topic name itself is the secret: a long,
random, unguessable slug (not `switchtender` or anything guessable),
generated fresh and stored as a normal 1Password item / Secret Manager
secret, the same pattern as the project's other keys (CLAUDE.md rule 7).

**Not yet decided (CMB-37, the build ticket):** the exact topic-name
generation and storage steps, and how "verdict differs from the last send"
is computed given Cloud Run holds no state between calls (scales to zero) —
the plan is to read the previous verdict back from the already-logged sheet
row.
