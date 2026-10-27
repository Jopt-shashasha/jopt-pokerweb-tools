# Cloudflare traffic

Admin page: `/console/cloudflare-traffic`. API: `GET /api/cloudflare-traffic?period=24h|7d`.
Owner/admin access only; the API is authenticated by the existing Harness middleware.

## Connection

Configure these server-side bindings:

- `CF_ANALYTICS_ACCOUNT_ID`: the existing Cloudflare account ID.
- `WORKER_NAME`: the existing Harness Worker name (already configured on this installation).
- `CF_ANALYTICS_TOKEN`: a dedicated Cloudflare API token with **Account / Account Analytics / Read**, scoped to this account. Store using Worker secrets; never expose in `NEXT_PUBLIC_*`, client assets, logs, screenshots or this document.

Do not reuse the Wrangler OAuth token or set the self-update `CF_API_TOKEN` for this feature.
There are no database changes, scheduled jobs or paid resources. Missing credentials display “未接続”, not zero usage.

## Metrics

Source: Cloudflare GraphQL `workersInvocationsAdaptive`, filtered by server-configured script name/account. Two queries in one request retrieve overall aggregates and hourly series. CPU quantiles come from the overall aggregate, never an average of hourly percentiles. GraphQL CPU microseconds are converted to milliseconds. HTTP and GraphQL errors are treated as unavailable, not empty traffic. Requests are not LINE messages, unique visitors, bandwidth or a bill.

The API uses 60-second per-isolate caching/coalescing, with no public response caching; time ranges are rolling 24h/7d, displayed explicitly in Asia/Tokyo. No polling. A credential/target change invalidates reuse. Upstream timeouts are 10 seconds and redirects are rejected.

References: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/ ; https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/


## Capacity dashboard

The primary page is now `サービス残量・稼働状況`; request/CPU charts are supplementary. `GET /api/service-capacity` has the same owner/admin access control, with independent provider statuses.

- Cloudflare uses account-wide official Workers requests and D1 read/write/storage metrics. Free daily reset is 00:00 UTC = 09:00 Asia/Tokyo. `CF_CAPACITY_PLAN=free` is explicitly configured only after verifying the actual plan; no plan is inferred from request volume.
- Appwrite uses a separate `APPWRITE_USAGE_API_KEY` with only `usage.read`, calling official `/usage/events` and `/usage/gauges`. The existing storage key is unchanged. Missing gauge samples remain unknown, rather than zero.
- `APPWRITE_BILLING_ANCHOR`, `APPWRITE_BANDWIDTH_LIMIT_BYTES`, `APPWRITE_STORAGE_LIMIT_BYTES` record the officially verified billing cycle and allowances. These are configuration, not claims that the usage API returns limits. Appwrite Free allowances are organization-shared; this organization currently has one project. Adding projects or changing plan requires reviewing the quota configuration.
- Remaining = verified plan allowance minus official observed usage. UI warns at 75%, 90%, and 100%. These are display thresholds, not automatic messages to colleagues and not automatic upgrades.
- Provider pause/permission/availability errors are distinct from exhausted quota. Appwrite Free may pause after seven days without Console development activity, independently of traffic. No fake keepalive traffic or automatic paid-plan change is implemented.

Live inspection on 2026-10-26: Appwrite returned `project_paused`; the user explicitly authorized restoring the Free project. After restoration, native Storage API returned 200. The official billing UI showed 37.22 MB / 5 GB bandwidth and 3.07 MB / 2 GB storage, cycle Oct 17-Nov 16, with an approximately five-hour billing-data delay. These are dated observations, not live counters.


Appwrite `harness-usage-read` was created with user approval, **only `usage.read` and no expiration**, and saved only as Worker secret `APPWRITE_USAGE_API_KEY`. Both official usage endpoints returned 200. The independent file-storage credential was not changed. The Cloudflare analytics credential retains its previously approved 2027-01-24 expiry; the capacity UI shows this separately. No reminder automation was created.

Calculation precision: published Appwrite Free limits are converted conservatively using SI GB (10^9 bytes). Appwrite's Console currently displays billing dates Oct 17-Nov 16 but does not expose an exact reset clock through the project usage API. The query uses the displayed date as its UTC aggregate boundary, and the UI marks the exact reset hour unconfirmed. These are reference balances from official usage, not a claim of a provider-returned remaining-budget field. Organization billing figures can lag by hours. Gauge absence is unknown; a valid zero sample is zero.
