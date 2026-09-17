# Routes API cost and the spend guardrail (CMB-19)

Pricing read on 2026-09-16 from the live Google pages. Every price below was
read from a page dated "Last updated 2026-09-10 UTC" unless marked UNVERIFIED.

## What one verdict sends

`src/routes.js` issues three `computeRoutes` calls per verdict:

| Call | Shape (from `driveRequest` / `transitRequest`) | Field mask |
| --- | --- | --- |
| a. drive, fork to destination | `travelMode: DRIVE`, `routingPreference: TRAFFIC_AWARE_OPTIMAL`, `extraComputations: [TRAFFIC_ON_POLYLINE]`, `polylineQuality: HIGH_QUALITY` | `routes.duration, routes.distanceMeters, routes.polyline.encodedPolyline, routes.travelAdvisory.speedReadingIntervals` |
| b. drive, fork to park-and-ride | identical to (a) | identical to (a) |
| c. transit, park-and-ride to destination | `travelMode: TRANSIT`, nothing else | `routes.duration, routes.distanceMeters` |

## Which SKU each call bills to

Google bills one SKU per request, the highest tier any requested feature
belongs to ("If you request any features from a higher-priced SKU, then your
request is billed at the higher rate. You are only charged for one SKU per
request." -- SKU details page).

| SKU | SKU ID (Global) | Triggers quoted from the SKU details page | Free per month | Price per 1000, 0-100K tier |
| --- | --- | --- | --- | --- |
| Routes: Compute Routes Essentials | 9EFF-679A-9B16 | "Requests to Compute Routes that don't use Pro or Enterprise features." | 10,000 | $5.00 |
| Routes: Compute Routes Pro | 02F7-1B55-DC90 | "Use between 11 and 25 intermediate waypoints. Set optimizeWaypointOrder: true. Set routingPreference to TRAFFIC_AWARE or TRAFFIC_AWARE_OPTIMAL. Set one of the following location modifiers: Side of the road, Heading, Vehicle stopover" | 5,000 | $10.00 |
| Routes: Compute Routes Enterprise | 6EBD-08E5-319A | "Two-wheeled vehicle routing. Toll calculation. Traffic information on polylines" | 1,000 | $15.00 |

Higher volume tiers (per 1000): Essentials $4.00 / $3.00 / $1.50 / $0.38,
Pro $8.00 / $6.00 / $3.00 / $0.75, Enterprise $12.00 / $9.00 / $4.50 / $1.14
for 100K-500K / 500K-1M / 1M-5M / 5M+. Irrelevant at this tool's volume.

Mapping the calls:

- **(a) and (b) bill to Compute Routes Enterprise.** `TRAFFIC_AWARE_OPTIMAL`
  alone would be Pro, but `extraComputations: TRAFFIC_ON_POLYLINE` (which is
  what populates `speedReadingIntervals`) is "Traffic information on
  polylines", an Enterprise trigger. `polylineQuality: HIGH_QUALITY` is not
  listed as a trigger for any tier.
- **(c) bills to Compute Routes Essentials.** `travelMode: TRANSIT` is not
  listed as a Pro or Enterprise trigger on the SKU details page, and the
  request sets no other feature. (Transit-specific pricing was not found on
  any of the three pages read; treat "Essentials" as the reading of the
  trigger lists, not a quoted statement about transit.)

Free usage and volume tiers are aggregated per billing account per month
across all projects, not per project (pricing page: usage "aggregates across
all projects in a billing account"). This billing account has no other Maps
Platform consumer that we know of.

Sources:

- SKU triggers: https://developers.google.com/maps/billing-and-pricing/sku-details (anchors `#compute-routes-ess-sku`, `#compute-routes-pro-sku`, `#compute-routes-ent-sku`)
- Prices and free caps: https://developers.google.com/maps/billing-and-pricing/pricing
- Tier overview: https://developers.google.com/maps/documentation/routes/usage-and-billing
- Model change (free calls per SKU replaced the $200 credit on 2025-03-01): https://mapsplatform.google.com/pricing/

## Two scenarios

| Scenario | Enterprise calls | Essentials calls | Enterprise billable (after 1,000 free) | Cost |
| --- | --- | --- | --- | --- |
| Normal: 2 verdicts per weekday, ~44 verdicts, 132 calls | 88 | 44 | 0 | **$0.00** |
| Runaway: 1 verdict per minute for a day, 1,440 verdicts, 4,320 calls | 2,880 | 1,440 | 1,880 | **$28.20** |
| Runaway day on top of a normal month | 2,968 | 1,484 | 1,968 | $29.52 |

Essentials never leaves its 10,000 free calls in any scenario. Enterprise
leaves its 1,000 free calls after 500 verdicts in a month, so the free tier
covers about eleven normal months of headroom but less than nine hours of a
runaway.

Cost lever, not applied: dropping `TRAFFIC_ON_POLYLINE` from call (b) (the
short leg to the garage, whose congestion is recorded but "not the deciding
factor") would move it to Pro, where the free cap is 5,000. That would take the
runaway day to 1,440 Enterprise (440 billable, $6.60) + 1,440 Pro (free).
Dropping it from both would zero every scenario above but would also remove
the congestion signal the verdict rule reads, so it is not an option.

## Everything else on the project

- **Cloud Run** (request-based billing, us-central1 pricing): free tier is
  "First 180,000 vCPU-seconds free per month", "First 360,000 GiB-seconds
  free per month", "2 million requests free per month"; requests are $0.40 per
  million after that. 1,440 invocations a day is far inside all three.
  Expected: **$0.00**. Source: https://cloud.google.com/run/pricing
- **Secret Manager**: "Active secret versions ... 6 versions" free, then
  $0.000082192 per version-hour (about $0.06 per version-month); "Access
  operations ... 10,000 operations" free, then $0.03 per 10,000. The project
  holds six secrets (see `docs/deploy.md`), so it sits exactly at the free
  version limit; a seventh enabled version (for example an old version left
  enabled after a rotation) costs about $0.06 a month. Access operations
  happen at instance start, not per verdict; even 1,440 cold starts x 6
  secrets = 8,640 stays free. Expected: **$0.00**. Source:
  https://cloud.google.com/secret-manager/pricing
- Cloud Build and Artifact Registry are used by source deploys and have their
  own free tiers; not measured here. UNVERIFIED at this volume.

## The guardrail budget

Billing account linked to `commuter-bot-501717`: `billingAccounts/01DB47-7E8232-EF7A2A`
(`gcloud billing projects describe commuter-bot-501717`, 2026-09-16).

**Status: not created.** The Cloud Billing Budget API is not enabled on the
project, and the agent harness refused to run `gcloud services enable` from
the worktree (twice, same refusal). No budget named "switchtender guardrail"
can exist yet because `gcloud billing budgets list` fails with
`SERVICE_DISABLED` for the same reason. The owner should run, from any shell:

```sh
gcloud services enable billingbudgets.googleapis.com --project=commuter-bot-501717

gcloud billing budgets list --billing-account=01DB47-7E8232-EF7A2A \
  --format="table(displayName,amount.specifiedAmount.units,budgetFilter.projects)"
# if "switchtender guardrail" is already listed, stop here

gcloud billing budgets create \
  --billing-account=01DB47-7E8232-EF7A2A \
  --display-name="switchtender guardrail" \
  --budget-amount=20USD \
  --calendar-period=month \
  --filter-projects=projects/commuter-bot-501717 \
  --threshold-rule=percent=0.5,basis=current-spend \
  --threshold-rule=percent=0.9,basis=current-spend \
  --threshold-rule=percent=1.0,basis=current-spend
```

Email to the billing account's admins and users is the default notification
and needs no flag. If `--filter-projects` is refused with the project ID,
substitute the project number
(`gcloud projects describe commuter-bot-501717 --format='value(projectNumber)'`).
The budget is a notification, not a cap: nothing stops the API at $20. The
real cap is the free tier arithmetic above plus the verdict cadence.
